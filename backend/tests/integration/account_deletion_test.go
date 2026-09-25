//go:build integration

package integration_test

import (
	"context"
	"errors"
	"sort"
	"strings"
	"sync"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestAccountDeletionPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	store, err := postgresadapter.NewAccountDeletionStore(pool)
	if err != nil {
		t.Fatal(err)
	}

	scope := accountDeletionScope(seedPrivacyOwner(t, ctx, pool, 71))
	operation := accountDeletionOperation(t, scope, 2_701, 1_000)
	continuation := accountDeletionContinuation(t, operation, 'A', 'B', 9_000)
	created, err := store.Start(ctx, operation, continuation)
	if err != nil || created.Kind != accountdeletion.StartCreated ||
		!accountdeletion.SameOperation(created.Snapshot.Operation, operation) {
		t.Fatalf("Start() = %#v, %v", created, err)
	}

	assertAccountDeletionStartReplayAndIsolation(t, ctx, pool, store, scope, operation, continuation)
	consumed := assertAccountDeletionContinuationCAS(t, ctx, store, continuation)
	assertAccountDeletionTransitionCAS(t, ctx, store, scope, consumed.Snapshot)
	assertAccountDeletionJournalSurvivesOwnerRemoval(t, ctx, pool, store)
	assertMalformedAccountDeletionFailsClosed(t, ctx, pool, store, scope)

	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

func assertAccountDeletionStartReplayAndIsolation(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.AccountDeletionStore,
	scope accountdeletion.Scope,
	operation accountdeletion.Operation,
	continuation accountdeletion.Continuation,
) {
	t.Helper()
	replayOperation := accountDeletionOperation(t, scope, 2_702, 1_100)
	replayContinuation := accountDeletionContinuation(t, replayOperation, 'A', 'B', 10_000)
	replayed, err := store.Start(ctx, replayOperation, replayContinuation)
	if err != nil || replayed.Kind != accountdeletion.StartExisting ||
		replayed.Snapshot.Operation.OperationID != operation.OperationID || replayed.Continuation.ExpiresAt != 10_000 {
		t.Fatalf("replayed Start() = %#v, %v", replayed, err)
	}

	conflictingContinuation := accountDeletionContinuation(t, replayOperation, 'C', 'D', 10_000)
	conflicting, err := store.Start(ctx, replayOperation, conflictingContinuation)
	if err != nil || conflicting.Kind != accountdeletion.StartRejected ||
		conflicting.Reason != accountdeletion.StartCredentialConflict {
		t.Fatalf("conflicting Start() = %#v, %v", conflicting, err)
	}

	missingScope := accountDeletionScopeForSuffix(t, 972)
	missingOperation := accountDeletionOperation(t, missingScope, 2_703, 1_000)
	missingContinuation := accountDeletionContinuation(t, missingOperation, 'E', 'F', 9_000)
	missing, err := store.Start(ctx, missingOperation, missingContinuation)
	if err != nil || missing.Kind != accountdeletion.StartRejected || missing.Reason != accountdeletion.StartInvalid {
		t.Fatalf("missing-owner Start() = %#v, %v", missing, err)
	}

	other := accountDeletionScope(seedPrivacyOwner(t, ctx, pool, 72))
	operationCollision := accountDeletionOperation(t, other, 2_701, 1_000)
	collisionContinuation := accountDeletionContinuation(t, operationCollision, 'G', 'H', 9_000)
	collision, err := store.Start(ctx, operationCollision, collisionContinuation)
	if err != nil || collision.Kind != accountdeletion.StartRejected || collision.Reason != accountdeletion.StartInvalid {
		t.Fatalf("cross-owner operation collision = %#v, %v", collision, err)
	}

	wrongSecret, _ := accountdeletion.ParseCredentialHash(strings.Repeat("Z", 43))
	wrong, err := store.Consume(ctx, wrongSecret, 0, 1_200)
	if err != nil || wrong.Kind != accountdeletion.ConsumeRejected || wrong.Reason != accountdeletion.ConsumeInvalidCapability {
		t.Fatalf("wrong-secret Consume() = %#v, %v", wrong, err)
	}
	future, err := store.Consume(ctx, continuation.SecretHash, 2, 1_200)
	if err != nil || future.Kind != accountdeletion.ConsumeRejected || future.Reason != accountdeletion.ConsumeInvalidCapability {
		t.Fatalf("future-sequence Consume() = %#v, %v", future, err)
	}

	expiredScope := accountDeletionScope(seedPrivacyOwner(t, ctx, pool, 74))
	expiredOperation := accountDeletionOperation(t, expiredScope, 2_705, 1_000)
	expiredContinuation := accountDeletionContinuation(t, expiredOperation, 'K', 'L', 1_500)
	if result, startErr := store.Start(ctx, expiredOperation, expiredContinuation); startErr != nil || result.Kind != accountdeletion.StartCreated {
		t.Fatalf("expired fixture Start() = %#v, %v", result, startErr)
	}
	expired, err := store.Consume(ctx, expiredContinuation.SecretHash, 0, 1_500)
	if err != nil || expired.Kind != accountdeletion.ConsumeRejected || expired.Reason != accountdeletion.ConsumeExpired {
		t.Fatalf("expired Consume() = %#v, %v", expired, err)
	}
}

func assertAccountDeletionContinuationCAS(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.AccountDeletionStore,
	continuation accountdeletion.Continuation,
) accountdeletion.ConsumeResult {
	t.Helper()
	type outcome struct {
		result accountdeletion.ConsumeResult
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, 2)
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, err := store.Consume(ctx, continuation.SecretHash, 0, 1_200)
			outcomes <- outcome{result: result, err: err}
		}()
	}
	close(start)
	wait.Wait()
	close(outcomes)
	kinds := make([]string, 0, 2)
	var consumed accountdeletion.ConsumeResult
	for candidate := range outcomes {
		if candidate.err != nil {
			t.Fatal(candidate.err)
		}
		kinds = append(kinds, string(candidate.result.Kind))
		if candidate.result.Kind == accountdeletion.ConsumeConsumed {
			consumed = candidate.result
		}
		if candidate.result.Continuation.Sequence != 1 {
			t.Fatalf("continuation sequence = %d", candidate.result.Continuation.Sequence)
		}
	}
	sort.Strings(kinds)
	if strings.Join(kinds, ",") != "consumed,replayed" {
		t.Fatalf("concurrent Consume() kinds = %v", kinds)
	}
	return consumed
}

func assertAccountDeletionTransitionCAS(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.AccountDeletionStore,
	scope accountdeletion.Scope,
	snapshot accountdeletion.Snapshot,
) {
	t.Helper()
	claim := accountdeletion.PlanStepClaim(snapshot.Operation, 1_300, 1_500)
	if claim.Kind != accountdeletion.PlanAccepted {
		t.Fatalf("claim plan = %#v", claim)
	}
	type outcome struct {
		result accountdeletion.CommitResult
		err    error
	}
	start := make(chan struct{})
	outcomes := make(chan outcome, 2)
	var wait sync.WaitGroup
	for range 2 {
		wait.Add(1)
		go func() {
			defer wait.Done()
			<-start
			result, err := store.Commit(ctx, scope, claim.Transition)
			outcomes <- outcome{result: result, err: err}
		}()
	}
	close(start)
	wait.Wait()
	close(outcomes)
	kinds := make([]string, 0, 2)
	for candidate := range outcomes {
		if candidate.err != nil {
			t.Fatal(candidate.err)
		}
		kinds = append(kinds, string(candidate.result.Kind))
	}
	sort.Strings(kinds)
	if strings.Join(kinds, ",") != "applied,replayed" {
		t.Fatalf("concurrent Commit() kinds = %v", kinds)
	}

	code, _ := accountdeletion.ParseFailureCode("provider-unavailable")
	alternate := accountdeletion.PlanStepCompletion(claim.Transition.Next, accountdeletion.StepResult{
		Kind: accountdeletion.StepTerminalFailure, Step: accountdeletion.StepRevokeSessions,
		Attempt: 1, FinishedAt: 1_400, FailureCode: code,
	}, nil, accountdeletion.RetryPolicy{})
	success := accountdeletion.PlanStepCompletion(claim.Transition.Next, accountdeletion.StepResult{
		Kind: accountdeletion.StepSucceeded, Step: accountdeletion.StepRevokeSessions,
		Attempt: 1, FinishedAt: 1_400,
	}, nil, accountdeletion.RetryPolicy{})
	if alternate.Kind != accountdeletion.PlanAccepted || success.Kind != accountdeletion.PlanAccepted {
		t.Fatalf("completion plans = %#v / %#v", alternate, success)
	}
	applied, err := store.Commit(ctx, scope, success.Transition)
	if err != nil || applied.Kind != accountdeletion.CommitApplied || applied.Current == nil || len(applied.Current.Receipts) != 1 {
		t.Fatalf("success Commit() = %#v, %v", applied, err)
	}
	replayed, err := store.Commit(ctx, scope, success.Transition)
	if err != nil || replayed.Kind != accountdeletion.CommitReplayed || replayed.Current == nil || len(replayed.Current.Receipts) != 1 {
		t.Fatalf("success replay Commit() = %#v, %v", replayed, err)
	}
	conflict, err := store.Commit(ctx, scope, alternate.Transition)
	if err != nil || conflict.Kind != accountdeletion.CommitConflict {
		t.Fatalf("alternate Commit() = %#v, %v", conflict, err)
	}
}

func assertAccountDeletionJournalSurvivesOwnerRemoval(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.AccountDeletionStore,
) {
	t.Helper()
	scope := accountDeletionScope(seedPrivacyOwner(t, ctx, pool, 73))
	operation := accountDeletionOperation(t, scope, 2_704, 2_000)
	continuation := accountDeletionContinuation(t, operation, 'I', 'J', 9_000)
	if result, err := store.Start(ctx, operation, continuation); err != nil || result.Kind != accountdeletion.StartCreated {
		t.Fatalf("retained Start() = %#v, %v", result, err)
	}
	if _, err := pool.Exec(ctx, "DELETE FROM accounts WHERE account_id = $1", string(scope.AccountID)); err != nil {
		t.Fatalf("delete live Account/Vault: %v", err)
	}
	retained, err := store.Consume(ctx, continuation.SecretHash, 0, 2_100)
	if err != nil || retained.Kind != accountdeletion.ConsumeConsumed || retained.Snapshot.Operation.Scope != scope {
		t.Fatalf("retained continuation = %#v, %v", retained, err)
	}
}

func assertMalformedAccountDeletionFailsClosed(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.AccountDeletionStore,
	scope accountdeletion.Scope,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, "ALTER TABLE account_deletion_operations DROP CONSTRAINT account_deletion_operations_shape_check"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE account_deletion_operations SET state = 'completed', completed_at = NULL WHERE account_id = $1", string(scope.AccountID)); err != nil {
		t.Fatal(err)
	}
	if _, err := store.FindByOwner(ctx, scope); !errors.Is(err, postgresadapter.ErrInvalidAccountDeletionRecord) {
		t.Fatalf("malformed row error = %v", err)
	}
}

func accountDeletionScope(scope privacyrequest.Scope) accountdeletion.Scope {
	return accountdeletion.Scope{AccountID: scope.AccountID, VaultID: scope.VaultID}
}

func accountDeletionScopeForSuffix(t *testing.T, suffix int) accountdeletion.Scope {
	t.Helper()
	return accountdeletion.Scope{
		AccountID: integrationAccountID(t, 100+suffix),
		VaultID:   integrationVaultID(t, 200+suffix),
	}
}

func accountDeletionOperation(
	t *testing.T,
	scope accountdeletion.Scope,
	operationSuffix int,
	createdAt int64,
) accountdeletion.Operation {
	t.Helper()
	operationID, err := accountdeletion.ParseOperationID(integrationUUID(t, operationSuffix))
	if err != nil {
		t.Fatal(err)
	}
	plan := accountdeletion.PlanStart(scope, operationID, createdAt)
	if plan.Kind != accountdeletion.PlanAccepted {
		t.Fatalf("PlanStart() = %#v", plan)
	}
	return plan.Operation
}

func accountDeletionContinuation(
	t *testing.T,
	operation accountdeletion.Operation,
	idempotencyCharacter byte,
	secretCharacter byte,
	expiresAt int64,
) accountdeletion.Continuation {
	t.Helper()
	idempotencyHash, err := accountdeletion.ParseCredentialHash(strings.Repeat(string(idempotencyCharacter), 43))
	if err != nil {
		t.Fatal(err)
	}
	secretHash, err := accountdeletion.ParseCredentialHash(strings.Repeat(string(secretCharacter), 43))
	if err != nil {
		t.Fatal(err)
	}
	plan := accountdeletion.PlanContinuationStart(operation, idempotencyHash, secretHash, expiresAt)
	if plan.Kind != accountdeletion.ContinuationStartAccepted {
		t.Fatalf("PlanContinuationStart() = %#v", plan)
	}
	return plan.Continuation
}
