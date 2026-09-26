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
	"github.com/fukamu/notes/backend/internal/identity"
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
	assertAccountDeletionTransitionCAS(t, ctx, pool, store, scope, consumed.Snapshot)
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
		replayed.Snapshot.Operation.OperationID != operation.OperationID || replayed.Continuation.ExpiresAt != 9_000 {
		t.Fatalf("replayed Start() = %#v, %v", replayed, err)
	}
	renewOperation := accountDeletionOperation(t, scope, 2_706, 9_000)
	renewContinuation := accountDeletionContinuation(t, renewOperation, 'A', 'B', 17_000)
	renewed, err := store.Start(ctx, renewOperation, renewContinuation)
	if err != nil || renewed.Kind != accountdeletion.StartExisting || renewed.Continuation.ExpiresAt != 17_000 ||
		renewed.Continuation.Sequence != continuation.Sequence {
		t.Fatalf("expired renewal Start() = %#v, %v", renewed, err)
	}
	replayedAgain, err := store.Start(ctx, renewOperation, renewContinuation)
	if err != nil || replayedAgain.Kind != accountdeletion.StartExisting ||
		replayedAgain.Continuation != renewed.Continuation {
		t.Fatalf("renewal replay Start() = %#v, %v", replayedAgain, err)
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
	pool *pgxpool.Pool,
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
	postClaimOperation := accountDeletionOperation(t, scope, 2_707, 1_350)
	postClaimContinuation := accountDeletionContinuation(t, postClaimOperation, 'A', 'B', 20_000)
	postClaim, err := store.Start(ctx, postClaimOperation, postClaimContinuation)
	if err != nil || postClaim.Kind != accountdeletion.StartExisting ||
		postClaim.Continuation.ExpiresAt != identity.MaximumSafeInteger {
		t.Fatalf("post-claim Start() = %#v, %v", postClaim, err)
	}
	var sequence, expiresAt, updatedAt int64
	if err := pool.QueryRow(ctx, `SELECT sequence, expires_at, updated_at
		FROM account_deletion_continuations WHERE operation_id = $1`,
		string(snapshot.Operation.OperationID),
	).Scan(&sequence, &expiresAt, &updatedAt); err != nil {
		t.Fatal(err)
	}
	if sequence != 1 || expiresAt != identity.MaximumSafeInteger || updatedAt != claim.Transition.Next.UpdatedAt {
		t.Fatalf("claim recovery credential sequence=%d expires=%d updated=%d", sequence, expiresAt, updatedAt)
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

	current := *applied.Current
	for _, step := range []accountdeletion.Step{
		accountdeletion.StepCancelSubscription,
		accountdeletion.StepDeleteVaultData,
	} {
		claimed := accountdeletion.PlanStepClaim(current.Operation, current.Operation.UpdatedAt+10, current.Operation.UpdatedAt+20)
		claimedResult, commitErr := store.Commit(ctx, scope, claimed.Transition)
		if commitErr != nil || claimedResult.Kind != accountdeletion.CommitApplied || claimedResult.Current == nil {
			t.Fatalf("claim %s Commit() = %#v, %v", step, claimedResult, commitErr)
		}
		running := claimedResult.Current.Operation.State.(accountdeletion.Running)
		completed := accountdeletion.PlanStepCompletion(claimedResult.Current.Operation, accountdeletion.StepResult{
			Kind: accountdeletion.StepSucceeded, Step: step, Attempt: running.Attempt,
			FinishedAt: claimedResult.Current.Operation.UpdatedAt + 5,
		}, nil, accountdeletion.RetryPolicy{})
		completedResult, commitErr := store.Commit(ctx, scope, completed.Transition)
		if commitErr != nil || completedResult.Kind != accountdeletion.CommitApplied || completedResult.Current == nil {
			t.Fatalf("complete %s Commit() = %#v, %v", step, completedResult, commitErr)
		}
		current = *completedResult.Current
	}
	privateClaim := accountdeletion.PlanStepClaim(
		current.Operation, current.Operation.UpdatedAt+10, current.Operation.UpdatedAt+20,
	)
	privateRunningResult, err := store.Commit(ctx, scope, privateClaim.Transition)
	if err != nil || privateRunningResult.Kind != accountdeletion.CommitApplied || privateRunningResult.Current == nil {
		t.Fatalf("private claim Commit() = %#v, %v", privateRunningResult, err)
	}
	privateRunning := privateRunningResult.Current.Operation.State.(accountdeletion.Running)
	progress := accountdeletion.PlanStepCompletion(
		privateRunningResult.Current.Operation,
		accountdeletion.StepResult{
			Kind: accountdeletion.StepProgressed, Step: accountdeletion.StepDeletePrivateObject,
			Attempt: privateRunning.Attempt, FinishedAt: privateRunningResult.Current.Operation.UpdatedAt + 5,
		}, nil, accountdeletion.RetryPolicy{},
	)
	progressed, err := store.Commit(ctx, scope, progress.Transition)
	if err != nil || progressed.Kind != accountdeletion.CommitApplied || progressed.Current == nil ||
		len(progressed.Current.Receipts) != 3 {
		t.Fatalf("progress Commit() = %#v, %v", progressed, err)
	}
	progressReplay, err := store.Commit(ctx, scope, progress.Transition)
	if err != nil || progressReplay.Kind != accountdeletion.CommitReplayed || progressReplay.Current == nil ||
		len(progressReplay.Current.Receipts) != 3 {
		t.Fatalf("progress replay Commit() = %#v, %v", progressReplay, err)
	}
	privateSuccess := accountdeletion.PlanStepCompletion(
		privateRunningResult.Current.Operation,
		accountdeletion.StepResult{
			Kind: accountdeletion.StepSucceeded, Step: accountdeletion.StepDeletePrivateObject,
			Attempt: privateRunning.Attempt, FinishedAt: privateRunningResult.Current.Operation.UpdatedAt + 5,
		}, nil, accountdeletion.RetryPolicy{},
	)
	progressConflict, err := store.Commit(ctx, scope, privateSuccess.Transition)
	if err != nil || progressConflict.Kind != accountdeletion.CommitConflict {
		t.Fatalf("progress conflict Commit() = %#v, %v", progressConflict, err)
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
