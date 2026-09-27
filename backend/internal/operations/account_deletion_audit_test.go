package operations

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestPlanAccountDeletionAuditMapsEveryDurableState(t *testing.T) {
	t.Parallel()
	query, operation := accountDeletionAuditFixture(t)
	failure, _ := accountdeletion.ParseFailureCode("provider-unavailable")
	tests := []struct {
		name       string
		state      accountdeletion.State
		observedAt int64
		wantState  AccountDeletionAuditState
		wantReady  bool
		wantAt     int64
		wantStep   accountdeletion.Step
		receipts   []accountdeletion.Receipt
	}{
		{name: "ready", state: accountdeletion.Ready{Step: accountdeletion.StepRevokeSessions, NotBefore: 1_000}, observedAt: 1_000, wantState: AccountDeletionStepReady, wantReady: true, wantAt: 1_000, wantStep: accountdeletion.StepRevokeSessions},
		{name: "waiting", state: accountdeletion.Ready{Step: accountdeletion.StepRevokeSessions, NotBefore: 1_100}, observedAt: 1_000, wantState: AccountDeletionStepWaiting, wantAt: 1_100, wantStep: accountdeletion.StepRevokeSessions},
		{name: "running", state: accountdeletion.Running{Step: accountdeletion.StepRevokeSessions, Attempt: 1, LeaseExpiresAt: 1_200}, observedAt: 1_199, wantState: AccountDeletionStepRunning, wantAt: 1_200, wantStep: accountdeletion.StepRevokeSessions},
		{name: "expired lease", state: accountdeletion.Running{Step: accountdeletion.StepRevokeSessions, Attempt: 1, LeaseExpiresAt: 1_200}, observedAt: 1_200, wantState: AccountDeletionLeaseExpired, wantReady: true, wantAt: 1_200, wantStep: accountdeletion.StepRevokeSessions},
		{name: "retry waiting", state: accountdeletion.RetryWait{Step: accountdeletion.StepRevokeSessions, Attempt: 1, RetryAt: 1_300, FailureCode: failure}, observedAt: 1_299, wantState: AccountDeletionRetryWaiting, wantAt: 1_300, wantStep: accountdeletion.StepRevokeSessions},
		{name: "retry due", state: accountdeletion.RetryWait{Step: accountdeletion.StepRevokeSessions, Attempt: 1, RetryAt: 1_300, FailureCode: failure}, observedAt: 1_300, wantState: AccountDeletionRetryDue, wantReady: true, wantAt: 1_300, wantStep: accountdeletion.StepRevokeSessions},
		{name: "terminal", state: accountdeletion.TerminalFailure{Step: accountdeletion.StepRevokeSessions, Attempt: 1, FailureCode: failure}, observedAt: 1_400, wantState: AccountDeletionTerminalFailure, wantAt: 1_000, wantStep: accountdeletion.StepRevokeSessions},
		{name: "completed", state: accountdeletion.Completed{CompletedAt: 1_500}, observedAt: 1_500, wantState: AccountDeletionCompleted, wantAt: 1_500, receipts: completedAuditReceipts(operation.OperationID)},
	}
	for _, test := range tests {
		test := test
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			candidate := operation
			candidate.State = test.state
			candidate.UpdatedAt = auditStateUpdatedAt(test.state)
			candidateQuery := query
			candidateQuery.ObservedAt = test.observedAt
			result, err := PlanAccountDeletionAudit(candidateQuery, accountdeletion.Snapshot{
				Operation: candidate, Receipts: test.receipts,
			})
			if err != nil || result.Kind != AccountDeletionAuditInspected || result.State != test.wantState ||
				result.ReadyToAdvance != test.wantReady || result.RelevantAt != test.wantAt ||
				result.Step != test.wantStep || result.OperationID != operation.OperationID ||
				result.ObservedAt != test.observedAt {
				t.Fatalf("PlanAccountDeletionAudit() = %#v, %v", result, err)
			}
		})
	}
}

func TestAccountDeletionAuditServiceRefusesAbsentOwnerAndFailsClosed(t *testing.T) {
	t.Parallel()
	query, operation := accountDeletionAuditFixture(t)
	repository := &accountDeletionAuditRepository{}
	service, err := NewAccountDeletionAuditService(repository)
	if err != nil {
		t.Fatal(err)
	}
	refused, err := service.Inspect(context.Background(), query)
	if err != nil || refused.Kind != AccountDeletionAuditRefused ||
		refused.Reason != AccountDeletionAuditOwnerMismatch || refused.OperationID != "" {
		t.Fatalf("absent audit = %#v, %v", refused, err)
	}

	foreign := operation
	foreign.Scope.VaultID, _ = identity.ParseVaultID("01991f20-61d2-7000-8000-000000000202")
	repository.snapshot = &accountdeletion.Snapshot{Operation: foreign}
	if _, err := service.Inspect(context.Background(), query); !errors.Is(err, ErrAccountDeletionAudit) {
		t.Fatalf("foreign snapshot error = %v", err)
	}

	repository.err = errors.New("private repository failure")
	if _, err := service.Inspect(context.Background(), query); err != repository.err {
		t.Fatalf("repository error = %v", err)
	}

	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	repository.err = cancelled.Err()
	if _, err := service.Inspect(cancelled, query); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled error = %v", err)
	}
}

func TestValidateAccountDeletionAuditQueryRejectsInvalidInput(t *testing.T) {
	t.Parallel()
	query, _ := accountDeletionAuditFixture(t)
	queries := []AccountDeletionAuditQuery{
		{},
		{AccountID: query.AccountID, VaultID: query.VaultID, ObservedAt: -1},
		{AccountID: query.AccountID, VaultID: query.VaultID, ObservedAt: identity.MaximumSafeInteger + 1},
	}
	for _, candidate := range queries {
		if ValidateAccountDeletionAuditQuery(candidate) == nil {
			t.Fatalf("accepted invalid query: %#v", candidate)
		}
	}
}

type accountDeletionAuditRepository struct {
	snapshot *accountdeletion.Snapshot
	err      error
}

func (repository *accountDeletionAuditRepository) FindByOwner(
	context.Context,
	accountdeletion.Scope,
) (*accountdeletion.Snapshot, error) {
	return repository.snapshot, repository.err
}

func accountDeletionAuditFixture(t *testing.T) (AccountDeletionAuditQuery, accountdeletion.Operation) {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	operationID, _ := accountdeletion.ParseOperationID("01991f20-61d2-7000-8000-000000000301")
	operation := accountdeletion.PlanStart(
		accountdeletion.Scope{AccountID: accountID, VaultID: vaultID}, operationID, 1_000,
	).Operation
	return AccountDeletionAuditQuery{AccountID: accountID, VaultID: vaultID, ObservedAt: 1_000}, operation
}

func auditStateUpdatedAt(state accountdeletion.State) int64 {
	switch value := state.(type) {
	case accountdeletion.Completed:
		return value.CompletedAt
	default:
		return 1_000
	}
}

func completedAuditReceipts(operationID accountdeletion.OperationID) []accountdeletion.Receipt {
	steps := []accountdeletion.Step{
		accountdeletion.StepRevokeSessions,
		accountdeletion.StepCancelSubscription,
		accountdeletion.StepDeleteVaultData,
		accountdeletion.StepDeletePrivateObject,
		accountdeletion.StepFinalizeAccount,
	}
	receipts := make([]accountdeletion.Receipt, 0, len(steps))
	for _, step := range steps {
		receipts = append(receipts, accountdeletion.Receipt{
			OperationID: operationID, Step: step, CompletedAt: 1_000,
		})
	}
	return receipts
}
