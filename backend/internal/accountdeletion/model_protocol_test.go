package accountdeletion

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

func TestAccountDeletionLifecycleReceiptsAndRetry(t *testing.T) {
	operation := mustStartOperation(t, 1_000)
	receipts := make([]Receipt, 0, len(orderedSteps))
	for index, step := range orderedSteps {
		startedAt := int64(1_100 + index*200)
		claim := PlanStepClaim(operation, startedAt, startedAt+100)
		if claim.Kind != PlanAccepted {
			t.Fatalf("claim %s = %#v", step, claim)
		}
		running, ok := claim.Transition.Next.State.(Running)
		if !ok || running.Step != step {
			t.Fatalf("running %s = %#v", step, claim.Transition.Next.State)
		}
		completed := PlanStepCompletion(claim.Transition.Next, StepResult{
			Kind: StepSucceeded, Step: step, Attempt: running.Attempt, FinishedAt: startedAt + 50,
		}, nil, RetryPolicy{})
		if completed.Kind != PlanAccepted || completed.Transition.Receipt == nil {
			t.Fatalf("complete %s = %#v", step, completed)
		}
		receipts = append(receipts, *completed.Transition.Receipt)
		operation = completed.Transition.Next
		if !ValidSnapshot(Snapshot{Operation: operation, Receipts: append([]Receipt(nil), receipts...)}) {
			t.Fatalf("snapshot after %s is invalid", step)
		}
	}
	if _, ok := operation.State.(Completed); !ok || len(receipts) != 5 {
		t.Fatalf("terminal operation = %#v; receipts = %d", operation, len(receipts))
	}

	operation = mustStartOperation(t, 2_000)
	claim := PlanStepClaim(operation, 2_100, 2_200)
	running := claim.Transition.Next.State.(Running)
	code, _ := ParseFailureCode("provider-unavailable")
	failed := PlanStepCompletion(claim.Transition.Next, StepResult{
		Kind: StepRetryableFailure, Step: running.Step, Attempt: running.Attempt,
		FinishedAt: 2_150, FailureCode: code,
	}, nil, RetryPolicy{DelaysMilli: []int64{100}})
	if failed.Kind != PlanAccepted {
		t.Fatalf("retryable failure = %#v", failed)
	}
	if early := PlanRetryResume(failed.Transition.Next, 2_249); early.Reason != ReasonNotReady {
		t.Fatalf("early retry = %#v", early)
	}
	resumed := PlanRetryResume(failed.Transition.Next, 2_250)
	reclaimed := PlanStepClaim(resumed.Transition.Next, 2_250, 2_350)
	running = reclaimed.Transition.Next.State.(Running)
	terminal := PlanStepCompletion(reclaimed.Transition.Next, StepResult{
		Kind: StepRetryableFailure, Step: running.Step, Attempt: running.Attempt,
		FinishedAt: 2_300, FailureCode: code,
	}, nil, RetryPolicy{DelaysMilli: []int64{100}})
	if terminal.Kind != PlanAccepted {
		t.Fatalf("retry exhaustion = %#v", terminal)
	}
	if _, ok := terminal.Transition.Next.State.(TerminalFailure); !ok {
		t.Fatalf("exhausted state = %#v", terminal.Transition.Next.State)
	}
}

func TestAccountDeletionExpiredLeaseAndInvalidSnapshotsFailClosed(t *testing.T) {
	operation := mustStartOperation(t, 3_000)
	claim := PlanStepClaim(operation, 3_100, 3_200)
	if early := PlanExpiredLeaseRecovery(claim.Transition.Next, 3_199, RetryPolicy{DelaysMilli: []int64{100}}); early.Reason != ReasonNotReady {
		t.Fatalf("early lease recovery = %#v", early)
	}
	recovered := PlanExpiredLeaseRecovery(claim.Transition.Next, 3_200, RetryPolicy{DelaysMilli: []int64{100}})
	state, ok := recovered.Transition.Next.State.(RetryWait)
	if recovered.Kind != PlanAccepted || !ok || state.RetryAt != 3_300 || state.FailureCode != "lease-expired" {
		t.Fatalf("expired lease recovery = %#v", recovered)
	}

	wrongScope := operation.Scope
	wrongScope.VaultID, _ = identity.ParseVaultID("01991f20-61d2-7000-8000-000000000202")
	if ValidTransition(wrongScope, claim.Transition) {
		t.Fatal("cross-owner transition was valid")
	}
	badReceipt := Receipt{OperationID: operation.OperationID, Step: StepCancelSubscription, CompletedAt: 3_150}
	if ValidSnapshot(Snapshot{Operation: operation, Receipts: []Receipt{badReceipt}}) {
		t.Fatal("non-prefix receipt was accepted")
	}
	bad := operation
	bad.State = RetryWait{Step: StepRevokeSessions, Attempt: 1, RetryAt: 3_100, FailureCode: "secret details!"}
	if ValidOperation(bad) {
		t.Fatal("sensitive failure detail was accepted")
	}
}

func TestEveryAccountDeletionStepCanRecoverRetryAndExpiredLease(t *testing.T) {
	for targetIndex, targetStep := range orderedSteps {
		t.Run(string(targetStep), func(t *testing.T) {
			operation, receipts := operationReadyAtStep(t, targetIndex, 5_000)
			claim := PlanStepClaim(operation, operation.UpdatedAt+10, operation.UpdatedAt+20)
			running := claim.Transition.Next.State.(Running)
			code, _ := ParseFailureCode("temporary-failure")
			failed := PlanStepCompletion(claim.Transition.Next, StepResult{
				Kind: StepRetryableFailure, Step: targetStep, Attempt: running.Attempt,
				FinishedAt: operation.UpdatedAt + 15, FailureCode: code,
			}, nil, RetryPolicy{DelaysMilli: []int64{25}})
			if failed.Kind != PlanAccepted {
				t.Fatalf("retry failure = %#v", failed)
			}
			retryAt := operation.UpdatedAt + 40
			resumed := PlanRetryResume(failed.Transition.Next, retryAt)
			if resumed.Kind != PlanAccepted || resumed.Transition.Next.State.(Ready).Step != targetStep ||
				!ValidSnapshot(Snapshot{Operation: resumed.Transition.Next, Receipts: receipts}) {
				t.Fatalf("retry resume = %#v", resumed)
			}

			recovered := PlanExpiredLeaseRecovery(
				claim.Transition.Next, operation.UpdatedAt+20,
				RetryPolicy{DelaysMilli: []int64{25}},
			)
			state, ok := recovered.Transition.Next.State.(RetryWait)
			if recovered.Kind != PlanAccepted || !ok || state.Step != targetStep ||
				!ValidSnapshot(Snapshot{Operation: recovered.Transition.Next, Receipts: receipts}) {
				t.Fatalf("lease recovery = %#v", recovered)
			}
		})
	}
}

func TestContinuationSequenceAndRunPlanning(t *testing.T) {
	operation := mustStartOperation(t, 4_000)
	hashA, _ := ParseCredentialHash(strings.Repeat("H", 43))
	hashB, _ := ParseCredentialHash(strings.Repeat("S", 43))
	started := PlanContinuationStart(operation, hashA, hashB, 9_000)
	if started.Kind != ContinuationStartAccepted {
		t.Fatalf("continuation start = %#v", started)
	}
	consumed := PlanContinuationConsume(started.Continuation, 0, 4_100)
	if consumed.Kind != ContinuationConsumeAdvance || consumed.Next.Sequence != 1 {
		t.Fatalf("continuation consume = %#v", consumed)
	}
	if replay := PlanContinuationConsume(consumed.Next, 0, 4_101); replay.Kind != ContinuationConsumeReplay {
		t.Fatalf("continuation replay = %#v", replay)
	}
	if future := PlanContinuationConsume(consumed.Next, 3, 4_102); future.Reason != ContinuationInvalidCapability {
		t.Fatalf("future sequence = %#v", future)
	}
	if expired := PlanContinuationConsume(consumed.Next, 1, 9_000); expired.Reason != ContinuationExpired {
		t.Fatalf("expired continuation = %#v", expired)
	}

	snapshot := Snapshot{Operation: operation}
	run := PlanRun(snapshot, 4_100, 100, RetryPolicy{DelaysMilli: []int64{50}})
	if run.Kind != RunClaimStep {
		t.Fatalf("ready run = %#v", run)
	}
	running := Snapshot{Operation: run.Transition.Next}
	if waiting := PlanRun(running, 4_199, 100, RetryPolicy{DelaysMilli: []int64{50}}); waiting.Kind != RunReport {
		t.Fatalf("unexpired run = %#v", waiting)
	}
	if recovery := PlanRun(running, 4_200, 100, RetryPolicy{DelaysMilli: []int64{50}}); recovery.Kind != RunAdvanceState {
		t.Fatalf("expired run = %#v", recovery)
	}
}

func TestAccountDeletionStrictProtocol(t *testing.T) {
	key := strings.Repeat("I", 43)
	valid := []byte(`{"idempotencyKey":"` + key + `"}`)
	command, err := DecodeStartCommand(valid)
	if err != nil || command.IdempotencyKey == "" {
		t.Fatalf("DecodeStartCommand() = %#v, %v", command, err)
	}
	for _, candidate := range [][]byte{
		append(bytes.Clone(valid), []byte(` {}`)...),
		[]byte(`{"idempotencyKey":"` + key + `","idempotencyKey":"` + key + `"}`),
		[]byte(`{"idempotencyKey":"` + key + `","accountId":"hidden"}`),
		[]byte("{\"idempotencyKey\":\"\xff\"}"),
		[]byte(`{"idempotencyKey":"\ud800"}`),
	} {
		if _, err := DecodeStartCommand(candidate); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("invalid start %q error = %v", candidate, err)
		}
	}
	secret := strings.Repeat("S", 43)
	token, err := ParseContinuationToken("ad1." + secret + ".2147483647")
	if err != nil {
		t.Fatal(err)
	}
	parsedSecret, sequence, err := ContinuationTokenParts(token)
	if err != nil || string(parsedSecret) != secret || sequence != MaximumRevision {
		t.Fatalf("token parts = %q, %d, %v", parsedSecret, sequence, err)
	}
	if _, err := ParseContinuationToken("ad1." + secret + ".2147483648"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("overflow sequence error = %v", err)
	}

	retry := []byte(`{"status":"retry-wait","retryAt":1e3,"continuationToken":"ad1.` + secret + `.1"}`)
	response, err := DecodePublicResponse(retry)
	if err != nil || response.RetryAt == nil || *response.RetryAt != 1_000 {
		t.Fatalf("retry response = %#v, %v", response, err)
	}
	if _, err := DecodePublicResponse([]byte(`{"status":"completed","continuationToken":"ad1.` + secret + `.1"}`)); !errors.Is(err, ErrInvalidPublicResponse) {
		t.Fatalf("terminal token error = %v", err)
	}
}

func mustStartOperation(t *testing.T, requestedAt int64) Operation {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	operationID, err := ParseOperationID("01991f20-61d2-7000-8000-000000003001")
	if err != nil {
		t.Fatal(err)
	}
	plan := PlanStart(Scope{AccountID: accountID, VaultID: vaultID}, operationID, requestedAt)
	if plan.Kind != PlanAccepted {
		t.Fatalf("PlanStart() = %#v", plan)
	}
	return plan.Operation
}

func operationReadyAtStep(t *testing.T, targetIndex int, requestedAt int64) (Operation, []Receipt) {
	t.Helper()
	operation := mustStartOperation(t, requestedAt)
	receipts := make([]Receipt, 0, targetIndex)
	for index := 0; index < targetIndex; index++ {
		startedAt := operation.UpdatedAt + 10
		claim := PlanStepClaim(operation, startedAt, startedAt+10)
		running := claim.Transition.Next.State.(Running)
		completed := PlanStepCompletion(claim.Transition.Next, StepResult{
			Kind: StepSucceeded, Step: running.Step, Attempt: running.Attempt,
			FinishedAt: startedAt + 5,
		}, nil, RetryPolicy{})
		if completed.Kind != PlanAccepted || completed.Transition.Receipt == nil {
			t.Fatalf("advance step %d = %#v", index, completed)
		}
		receipts = append(receipts, *completed.Transition.Receipt)
		operation = completed.Transition.Next
	}
	return operation, receipts
}
