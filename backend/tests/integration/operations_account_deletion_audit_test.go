//go:build integration

package integration_test

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOperationsAccountDeletionAuditIsScopedExhaustiveAndReadOnlyPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	store, err := postgresadapter.NewAccountDeletionStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	service, err := operations.NewAccountDeletionAuditService(store)
	if err != nil {
		t.Fatal(err)
	}

	readyScope, _ := startDeletionAuditOperation(t, ctx, pool, store, 81, 2_781, 'A', 'B', 1_000)
	runningScope, running := startDeletionAuditOperation(t, ctx, pool, store, 82, 2_782, 'C', 'D', 2_000)
	running = commitDeletionAuditTransition(t, ctx, store, runningScope,
		accountdeletion.PlanStepClaim(running.Operation, 2_100, 2_500))
	retryScope, retry := startDeletionAuditOperation(t, ctx, pool, store, 83, 2_783, 'E', 'F', 3_000)
	retry = commitDeletionAuditTransition(t, ctx, store, retryScope,
		accountdeletion.PlanStepClaim(retry.Operation, 3_100, 3_500))
	retryCode, _ := accountdeletion.ParseFailureCode("provider-unavailable")
	retry = commitDeletionAuditTransition(t, ctx, store, retryScope,
		accountdeletion.PlanStepCompletion(retry.Operation, accountdeletion.StepResult{
			Kind: accountdeletion.StepRetryableFailure, Step: accountdeletion.StepRevokeSessions,
			Attempt: 1, FinishedAt: 3_200, FailureCode: retryCode,
		}, nil, accountdeletion.RetryPolicy{DelaysMilli: []int64{500}}))
	terminalScope, terminal := startDeletionAuditOperation(t, ctx, pool, store, 84, 2_784, 'G', 'H', 4_000)
	terminal = commitDeletionAuditTransition(t, ctx, store, terminalScope,
		accountdeletion.PlanStepClaim(terminal.Operation, 4_100, 4_500))
	terminal = commitDeletionAuditTransition(t, ctx, store, terminalScope,
		accountdeletion.PlanStepCompletion(terminal.Operation, accountdeletion.StepResult{
			Kind: accountdeletion.StepTerminalFailure, Step: accountdeletion.StepRevokeSessions,
			Attempt: 1, FinishedAt: 4_200, FailureCode: retryCode,
		}, nil, accountdeletion.RetryPolicy{}))
	completedScope, completed := startDeletionAuditOperation(t, ctx, pool, store, 85, 2_785, 'I', 'J', 5_000)
	completed = completeDeletionAuditOperation(t, ctx, store, completedScope, completed, 5_100)

	assertDeletionAuditResult(t, service, readyScope, 1_000, operations.AccountDeletionStepReady, true, accountdeletion.StepRevokeSessions)
	assertDeletionAuditResult(t, service, runningScope, 2_499, operations.AccountDeletionStepRunning, false, accountdeletion.StepRevokeSessions)
	assertDeletionAuditResult(t, service, runningScope, 2_500, operations.AccountDeletionLeaseExpired, true, accountdeletion.StepRevokeSessions)
	assertDeletionAuditResult(t, service, retryScope, 3_699, operations.AccountDeletionRetryWaiting, false, accountdeletion.StepRevokeSessions)
	assertDeletionAuditResult(t, service, retryScope, 3_700, operations.AccountDeletionRetryDue, true, accountdeletion.StepRevokeSessions)
	assertDeletionAuditResult(t, service, terminalScope, 4_300, operations.AccountDeletionTerminalFailure, false, accountdeletion.StepRevokeSessions)
	assertDeletionAuditResult(t, service, completedScope, 6_000, operations.AccountDeletionCompleted, false, "")

	otherScope, _ := startDeletionAuditOperation(t, ctx, pool, store, 86, 2_786, 'K', 'L', 6_000)
	crossOwner := operations.AccountDeletionAuditQuery{
		AccountID: readyScope.AccountID, VaultID: otherScope.VaultID, ObservedAt: 6_100,
	}
	refused, err := service.Inspect(ctx, crossOwner)
	if err != nil || refused.Kind != operations.AccountDeletionAuditRefused ||
		refused.Reason != operations.AccountDeletionAuditOwnerMismatch || refused.OperationID != "" {
		t.Fatalf("cross-owner audit = %#v, %v", refused, err)
	}
	missingScope := accountDeletionScopeForSuffix(t, 987)
	missing, err := service.Inspect(ctx, operations.AccountDeletionAuditQuery{
		AccountID: missingScope.AccountID, VaultID: missingScope.VaultID, ObservedAt: 6_100,
	})
	if err != nil || missing.Kind != operations.AccountDeletionAuditRefused || missing.OperationID != "" {
		t.Fatalf("missing audit = %#v, %v", missing, err)
	}

	var operationCount, receiptCount, continuationCount int
	if err := pool.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM account_deletion_operations),
		(SELECT COUNT(*) FROM account_deletion_step_receipts),
		(SELECT COUNT(*) FROM account_deletion_continuations)`).Scan(
		&operationCount, &receiptCount, &continuationCount,
	); err != nil || operationCount != 6 || receiptCount != 5 || continuationCount != 6 {
		t.Fatalf("audit mutation counts = %d/%d/%d, %v", operationCount, receiptCount, continuationCount, err)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	_, err = service.Inspect(cancelled, operations.AccountDeletionAuditQuery{
		AccountID: readyScope.AccountID, VaultID: readyScope.VaultID, ObservedAt: 6_100,
	})
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled audit error = %v", err)
	}
}

func startDeletionAuditOperation(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.AccountDeletionStore,
	ownerSuffix int,
	operationSuffix int,
	idempotencyCharacter byte,
	secretCharacter byte,
	createdAt int64,
) (accountdeletion.Scope, accountdeletion.Snapshot) {
	t.Helper()
	scope := accountDeletionScope(seedPrivacyOwner(t, ctx, pool, ownerSuffix))
	operation := accountDeletionOperation(t, scope, operationSuffix, createdAt)
	continuation := accountDeletionContinuation(
		t, operation, idempotencyCharacter, secretCharacter, createdAt+10_000,
	)
	result, err := store.Start(ctx, operation, continuation)
	if err != nil || result.Kind != accountdeletion.StartCreated {
		t.Fatalf("start audit operation = %#v, %v", result, err)
	}
	return scope, result.Snapshot
}

func commitDeletionAuditTransition(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.AccountDeletionStore,
	scope accountdeletion.Scope,
	plan accountdeletion.Plan,
) accountdeletion.Snapshot {
	t.Helper()
	if plan.Kind != accountdeletion.PlanAccepted {
		t.Fatalf("account deletion plan = %#v", plan)
	}
	result, err := store.Commit(ctx, scope, plan.Transition)
	if err != nil || result.Kind != accountdeletion.CommitApplied || result.Current == nil {
		t.Fatalf("account deletion transition = %#v, %v", result, err)
	}
	return *result.Current
}

func completeDeletionAuditOperation(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.AccountDeletionStore,
	scope accountdeletion.Scope,
	snapshot accountdeletion.Snapshot,
	nextAt int64,
) accountdeletion.Snapshot {
	t.Helper()
	for _, step := range []accountdeletion.Step{
		accountdeletion.StepRevokeSessions,
		accountdeletion.StepCancelSubscription,
		accountdeletion.StepDeleteVaultData,
		accountdeletion.StepDeletePrivateObject,
		accountdeletion.StepFinalizeAccount,
	} {
		snapshot = commitDeletionAuditTransition(t, ctx, store, scope,
			accountdeletion.PlanStepClaim(snapshot.Operation, nextAt, nextAt+100))
		snapshot = commitDeletionAuditTransition(t, ctx, store, scope,
			accountdeletion.PlanStepCompletion(snapshot.Operation, accountdeletion.StepResult{
				Kind: accountdeletion.StepSucceeded, Step: step, Attempt: 1, FinishedAt: nextAt + 1,
			}, nil, accountdeletion.RetryPolicy{}))
		nextAt += 10
	}
	return snapshot
}

func assertDeletionAuditResult(
	t *testing.T,
	service *operations.AccountDeletionAuditService,
	scope accountdeletion.Scope,
	observedAt int64,
	wantState operations.AccountDeletionAuditState,
	wantReady bool,
	wantStep accountdeletion.Step,
) {
	t.Helper()
	result, err := service.Inspect(context.Background(), operations.AccountDeletionAuditQuery{
		AccountID: scope.AccountID, VaultID: scope.VaultID, ObservedAt: observedAt,
	})
	if err != nil || result.Kind != operations.AccountDeletionAuditInspected ||
		result.State != wantState || result.ReadyToAdvance != wantReady || result.Step != wantStep ||
		result.OperationID == "" || result.ObservedAt != observedAt {
		t.Fatalf("account deletion audit = %#v, %v", result, err)
	}
}
