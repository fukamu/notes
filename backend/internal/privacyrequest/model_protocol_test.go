package privacyrequest

import (
	"bytes"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

func TestPrivacyRequestLifecycleAndRetry(t *testing.T) {
	pending := mustStart(t, KindDisclosure, 1_000)
	receiptID := mustReceiptID(t, "01991f20-61d2-7000-8000-000000002701")
	verified := PlanVerification(pending, VerificationDecision{
		Kind: VerificationApproved, ReceiptID: receiptID, DecidedAt: 1_100,
	})
	if verified.Kind != PlanAccepted {
		t.Fatalf("PlanVerification() = %#v", verified)
	}
	processing := PlanProcessingStart(verified.Transition.Next, 1_200)
	if processing.Kind != PlanAccepted {
		t.Fatalf("PlanProcessingStart() = %#v", processing)
	}
	if invalid := PlanCompletion(processing.Transition.Next, 1_300, OutcomeAccountDeletionStarted); invalid.Reason != ReasonInvalidOutcome {
		t.Fatalf("mismatched completion = %#v", invalid)
	}
	failureCode, _ := ParseFailureCode("executor-unavailable")
	failed := PlanFailure(processing.Transition.Next, 1_300, failureCode, true)
	if failed.Kind != PlanAccepted {
		t.Fatalf("PlanFailure() = %#v", failed)
	}
	retried := PlanRetry(failed.Transition.Next, 1_400)
	if retried.Kind != PlanAccepted {
		t.Fatalf("PlanRetry() = %#v", retried)
	}
	restarted := PlanProcessingStart(retried.Transition.Next, 1_500)
	completed := PlanCompletion(restarted.Transition.Next, 1_600, OutcomeFulfilled)
	if completed.Kind != PlanAccepted || !ValidRecord(completed.Transition.Next) {
		t.Fatalf("PlanCompletion() = %#v", completed)
	}
	status, err := PublicStatusFromRecord(completed.Transition.Next)
	if err != nil || status.Status != StateCompleted || status.Outcome != OutcomeFulfilled {
		t.Fatalf("PublicStatusFromRecord() = %#v, %v", status, err)
	}
	encoded, err := EncodePublicStatus(status)
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := DecodePublicStatus(encoded)
	if err != nil || decoded != status {
		t.Fatalf("public status round trip = %#v, %v", decoded, err)
	}
}

func TestPrivacyRequestRejectionAndDeletionOutcome(t *testing.T) {
	pending := mustStart(t, KindDeletion, 2_000)
	rejected := PlanVerification(pending, VerificationDecision{
		Kind: VerificationRejected, Reason: RejectionIdentityNotVerified, DecidedAt: 2_100,
	})
	if rejected.Kind != PlanAccepted {
		t.Fatalf("rejection = %#v", rejected)
	}
	if retry := PlanRetry(rejected.Transition.Next, 2_200); retry.Reason != ReasonWrongState {
		t.Fatalf("terminal retry = %#v", retry)
	}

	verified := PlanVerification(pending, VerificationDecision{
		Kind:      VerificationApproved,
		ReceiptID: mustReceiptID(t, "01991f20-61d2-7000-8000-000000002702"),
		DecidedAt: 2_100,
	})
	processing := PlanProcessingStart(verified.Transition.Next, 2_200)
	completed := PlanCompletion(processing.Transition.Next, 2_300, OutcomeAccountDeletionStarted)
	if completed.Kind != PlanAccepted {
		t.Fatalf("deletion completion = %#v", completed)
	}
}

func TestPrivacyRequestStrictProtocol(t *testing.T) {
	valid := []byte(`{"submissionId":"01991f20-61d2-7000-8000-000000002601","requestKind":"disclosure"}`)
	command, err := DecodeSubmitCommand(valid)
	if err != nil || command.RequestKind != KindDisclosure {
		t.Fatalf("DecodeSubmitCommand() = %#v, %v", command, err)
	}
	requestID := `"01991f20-61d2-7000-8000-000000002501"`
	for _, candidate := range [][]byte{
		append(bytes.Clone(valid), []byte(` {}`)...),
		[]byte(`{"submissionId":"01991f20-61d2-7000-8000-000000002601","submissionId":"01991f20-61d2-7000-8000-000000002602","requestKind":"disclosure"}`),
		[]byte(`{"submissionId":"01991f20-61d2-7000-8000-000000002601","requestKind":"disclosure","unknown":true}`),
		[]byte("{\"submissionId\":\"\xff\",\"requestKind\":\"disclosure\"}"),
		[]byte(`{"submissionId":"\ud800","requestKind":"disclosure"}`),
	} {
		if _, err := DecodeSubmitCommand(candidate); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("invalid submit %q error = %v", candidate, err)
		}
	}
	if _, err := DecodeStatusCommand([]byte(`{"requestId":` + requestID + `,"requestId":` + requestID + `}`)); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("duplicate status error = %v", err)
	}
	if _, err := DecodePublicStatus([]byte(`{"requestId":` + requestID + `,"requestKind":"disclosure","requestedAt":1,"updatedAt":1,"status":"verification-pending","vaultId":"hidden"}`)); !errors.Is(err, ErrInvalidPublicResponse) {
		t.Fatalf("leaking response error = %v", err)
	}
	if status, err := DecodePublicStatus([]byte(`{"requestId":` + requestID + `,"requestKind":"disclosure","requestedAt":1e3,"updatedAt":1000.0,"status":"verification-pending"}`)); err != nil || status.RequestedAt != 1_000 {
		t.Fatalf("JavaScript integer response = %#v, %v", status, err)
	}
	if _, err := DecodePublicStatus([]byte(`{"requestId":` + requestID + `,"requestKind":"disclosure","requestedAt":9007199254740992,"updatedAt":9007199254740992,"status":"verification-pending"}`)); !errors.Is(err, ErrInvalidPublicResponse) {
		t.Fatalf("unsafe response integer error = %v", err)
	}
}

func mustStart(t *testing.T, kind RequestKind, requestedAt int64) Record {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	requestID, _ := ParseRequestID("01991f20-61d2-7000-8000-000000002501")
	submissionID, _ := ParseSubmissionID("01991f20-61d2-7000-8000-000000002601")
	plan := PlanStart(Scope{AccountID: accountID, VaultID: vaultID}, requestID, submissionID, kind, requestedAt)
	if plan.Kind != PlanAccepted {
		t.Fatalf("PlanStart() = %#v", plan)
	}
	return plan.Record
}

func mustReceiptID(t *testing.T, value string) VerificationReceiptID {
	t.Helper()
	parsed, err := ParseVerificationReceiptID(value)
	if err != nil {
		t.Fatal(err)
	}
	return parsed
}
