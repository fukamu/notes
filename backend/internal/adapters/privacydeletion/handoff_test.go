package privacydeletion

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
)

func TestDeriveStartIdentityIsStableOwnerBoundAndTenantIsolated(t *testing.T) {
	scope := handoffScope(t, 151, 251)
	requestID := handoffRequestID(t, "01991f20-61d2-7000-8000-000000002501")
	first, err := DeriveStartIdentity(scope, requestID)
	if err != nil {
		t.Fatal(err)
	}
	second, err := DeriveStartIdentity(scope, requestID)
	if err != nil || second != first {
		t.Fatalf("stable derivation = %#v, %#v, %v", first, second, err)
	}
	if first.Scope.AccountID != scope.AccountID || first.Scope.VaultID != scope.VaultID {
		t.Fatalf("derived scope = %#v", first.Scope)
	}
	if _, err := accountdeletion.ParseIdempotencyKey(string(first.Command.IdempotencyKey)); err != nil {
		t.Fatalf("idempotency key = %q, %v", first.Command.IdempotencyKey, err)
	}
	if _, err := accountdeletion.ParseOperationID(string(first.OperationID)); err != nil {
		t.Fatalf("operation ID = %q, %v", first.OperationID, err)
	}
	if string(first.OperationID)[:13] != string(requestID)[:13] {
		t.Fatalf("UUIDv7 timestamp prefix changed: %q, %q", first.OperationID, requestID)
	}
	if first.OperationID != "01991f20-61d2-7442-9703-e6f4616400f5" ||
		first.Command.IdempotencyKey != "FiClu_i6qz3cjds081LSQ0s4pcQql_qjSWAwBN_aAxE" {
		t.Fatalf("derivation compatibility vector changed: %#v", first)
	}

	ownerVariants := []privacyrequest.Scope{
		{AccountID: handoffScope(t, 152, 252).AccountID, VaultID: scope.VaultID},
		{AccountID: scope.AccountID, VaultID: handoffScope(t, 152, 252).VaultID},
	}
	for _, ownerVariant := range ownerVariants {
		otherOwner, variantErr := DeriveStartIdentity(ownerVariant, requestID)
		if variantErr != nil {
			t.Fatal(variantErr)
		}
		if otherOwner.OperationID == first.OperationID ||
			otherOwner.Command.IdempotencyKey == first.Command.IdempotencyKey {
			t.Fatalf("owner isolation failed: first=%#v other=%#v", first, otherOwner)
		}
	}
	otherRequest, err := DeriveStartIdentity(
		scope,
		handoffRequestID(t, "01991f20-61d2-7000-8000-000000002502"),
	)
	if err != nil {
		t.Fatal(err)
	}
	if otherRequest.OperationID == first.OperationID ||
		otherRequest.Command.IdempotencyKey == first.Command.IdempotencyKey {
		t.Fatalf("request isolation failed: first=%#v other=%#v", first, otherRequest)
	}
}

func TestDeriveStartIdentityRejectsMalformedTypedValues(t *testing.T) {
	validScope := handoffScope(t, 153, 253)
	validRequest := handoffRequestID(t, "01991f20-61d2-7000-8000-000000002503")
	tests := []struct {
		name      string
		scope     privacyrequest.Scope
		requestID privacyrequest.RequestID
	}{
		{name: "account", scope: privacyrequest.Scope{AccountID: "bad", VaultID: validScope.VaultID}, requestID: validRequest},
		{name: "vault", scope: privacyrequest.Scope{AccountID: validScope.AccountID, VaultID: "bad"}, requestID: validRequest},
		{name: "request", scope: validScope, requestID: "bad"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if _, err := DeriveStartIdentity(test.scope, test.requestID); !errors.Is(err, ErrInvalidHandoffConfiguration) {
				t.Fatalf("DeriveStartIdentity() error = %v", err)
			}
		})
	}
}

func TestHandoffMapsAccountDeletionResultsWithoutLeakingErrors(t *testing.T) {
	validResponse := handoffResponse(t, accountdeletion.PublicInProgress)
	completedResponse := accountdeletion.PublicResponse{Status: accountdeletion.PublicCompleted}
	tests := []struct {
		name          string
		result        accountdeletion.ApplicationResult
		startErr      error
		clock         int64
		scope         privacyrequest.Scope
		wantKind      privacyrequest.DeletionHandoffResultKind
		wantCode      string
		wantRetryable bool
		wantCalls     int
	}{
		{name: "started", result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationAccepted, Response: &validResponse}, clock: 1_500, scope: handoffScope(t, 154, 254), wantKind: privacyrequest.DeletionHandoffStarted, wantCalls: 1},
		{name: "existing terminal operation is still started", result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationAccepted, Response: &completedResponse}, clock: 1_500, scope: handoffScope(t, 155, 255), wantKind: privacyrequest.DeletionHandoffStarted, wantCalls: 1},
		{name: "credential conflict", result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationRejected, Reason: accountdeletion.ApplicationCredentialConflict}, clock: 1_500, scope: handoffScope(t, 156, 256), wantKind: privacyrequest.DeletionHandoffFailed, wantCode: "account-deletion-conflict", wantCalls: 1},
		{name: "invalid", result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationRejected, Reason: accountdeletion.ApplicationInvalidInput}, clock: 1_500, scope: handoffScope(t, 157, 257), wantKind: privacyrequest.DeletionHandoffFailed, wantCode: "account-deletion-invalid", wantCalls: 1},
		{name: "unavailable", result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationRejected, Reason: accountdeletion.ApplicationUnavailable}, clock: 1_500, scope: handoffScope(t, 158, 258), wantKind: privacyrequest.DeletionHandoffFailed, wantCode: "account-deletion-unavailable", wantRetryable: true, wantCalls: 1},
		{name: "dependency error", startErr: errors.New("secret provider detail"), clock: 1_500, scope: handoffScope(t, 159, 259), wantKind: privacyrequest.DeletionHandoffFailed, wantCode: "account-deletion-unavailable", wantRetryable: true, wantCalls: 1},
		{name: "missing response", result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationAccepted}, clock: 1_500, scope: handoffScope(t, 160, 260), wantKind: privacyrequest.DeletionHandoffFailed, wantCode: "account-deletion-invalid-result", wantCalls: 1},
		{name: "invalid response", result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationAccepted, Response: &accountdeletion.PublicResponse{Status: accountdeletion.PublicInProgress}}, clock: 1_500, scope: handoffScope(t, 161, 261), wantKind: privacyrequest.DeletionHandoffFailed, wantCode: "account-deletion-invalid-result", wantCalls: 1},
		{name: "unknown result", result: accountdeletion.ApplicationResult{Kind: "future"}, clock: 1_500, scope: handoffScope(t, 162, 262), wantKind: privacyrequest.DeletionHandoffFailed, wantCode: "account-deletion-invalid-result", wantCalls: 1},
		{name: "invalid clock", result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationAccepted, Response: &validResponse}, clock: -1, scope: handoffScope(t, 163, 263), wantKind: privacyrequest.DeletionHandoffFailed, wantCode: "account-deletion-invalid", wantCalls: 0},
		{name: "unsafe clock", result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationAccepted, Response: &validResponse}, clock: identity.MaximumSafeInteger + 1, scope: handoffScope(t, 164, 264), wantKind: privacyrequest.DeletionHandoffFailed, wantCode: "account-deletion-invalid", wantCalls: 0},
		{name: "invalid scope", result: accountdeletion.ApplicationResult{Kind: accountdeletion.ApplicationAccepted, Response: &validResponse}, clock: 1_500, scope: privacyrequest.Scope{}, wantKind: privacyrequest.DeletionHandoffFailed, wantCode: "account-deletion-invalid", wantCalls: 0},
	}
	requestID := handoffRequestID(t, "01991f20-61d2-7000-8000-000000002504")
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			starter := &handoffStarter{result: test.result, err: test.startErr}
			handoff, err := New(starter, func() int64 { return test.clock })
			if err != nil {
				t.Fatal(err)
			}
			result, err := handoff.StartExistingAccountDeletion(context.Background(), test.scope, requestID)
			if err != nil || result.Kind != test.wantKind || string(result.FailureCode) != test.wantCode ||
				result.Retryable != test.wantRetryable || starter.calls != test.wantCalls {
				t.Fatalf("handoff = %#v, calls=%d, err=%v", result, starter.calls, err)
			}
			if starter.calls == 1 {
				derived, deriveErr := DeriveStartIdentity(test.scope, requestID)
				if deriveErr != nil || starter.scope != derived.Scope || starter.command != derived.Command ||
					starter.operationID != derived.OperationID || starter.requestedAt != test.clock {
					t.Fatalf("start input = %#v, %#v, %q, %d, derive=%v", starter.scope, starter.command, starter.operationID, starter.requestedAt, deriveErr)
				}
			}
		})
	}
}

func TestNewRejectsIncompleteHandoffDependencies(t *testing.T) {
	starter := &handoffStarter{}
	if _, err := New(nil, func() int64 { return 1 }); !errors.Is(err, ErrInvalidHandoffConfiguration) {
		t.Fatalf("nil starter error = %v", err)
	}
	if _, err := New(starter, nil); !errors.Is(err, ErrInvalidHandoffConfiguration) {
		t.Fatalf("nil clock error = %v", err)
	}
}

type handoffStarter struct {
	result      accountdeletion.ApplicationResult
	err         error
	calls       int
	scope       accountdeletion.Scope
	command     accountdeletion.StartCommand
	operationID accountdeletion.OperationID
	requestedAt int64
}

func (starter *handoffStarter) Start(
	_ context.Context,
	scope accountdeletion.Scope,
	command accountdeletion.StartCommand,
	operationID accountdeletion.OperationID,
	requestedAt int64,
) (accountdeletion.ApplicationResult, error) {
	starter.calls++
	starter.scope = scope
	starter.command = command
	starter.operationID = operationID
	starter.requestedAt = requestedAt
	return starter.result, starter.err
}

func handoffScope(t *testing.T, accountSuffix int, vaultSuffix int) privacyrequest.Scope {
	t.Helper()
	accountID, err := identity.ParseAccountID(handoffUUID(accountSuffix))
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID(handoffUUID(vaultSuffix))
	if err != nil {
		t.Fatal(err)
	}
	return privacyrequest.Scope{AccountID: accountID, VaultID: vaultID}
}

func handoffRequestID(t *testing.T, value string) privacyrequest.RequestID {
	t.Helper()
	requestID, err := privacyrequest.ParseRequestID(value)
	if err != nil {
		t.Fatal(err)
	}
	return requestID
}

func handoffResponse(t *testing.T, status accountdeletion.PublicStatusKind) accountdeletion.PublicResponse {
	t.Helper()
	secret, err := accountdeletion.ParseContinuationSecret(strings.Repeat("S", 43))
	if err != nil {
		t.Fatal(err)
	}
	token, err := accountdeletion.CreateContinuationToken(secret, 0)
	if err != nil {
		t.Fatal(err)
	}
	return accountdeletion.PublicResponse{Status: status, ContinuationToken: token}
}

func handoffUUID(suffix int) string {
	return fmt.Sprintf("01991f20-61d2-7000-8000-%012d", suffix)
}
