//go:build integration

package integration_test

import (
	"context"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	accountdeletioncredential "github.com/fukamu/notes/backend/internal/adapters/accountdeletioncredential"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	privacydeletionadapter "github.com/fukamu/notes/backend/internal/adapters/privacydeletion"
	"github.com/fukamu/notes/backend/internal/privacyrequest"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestPrivacyDeletionHandoffStartsOneDurableSagaWithoutRunningEffects(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	scope := seedPrivacyOwner(t, ctx, pool, 71)
	privacyStore, deletionStore, deletionService, effects := newPrivacyDeletionServices(t, pool)
	handoff, err := privacydeletionadapter.New(deletionService, func() int64 { return 2_250 })
	if err != nil {
		t.Fatal(err)
	}
	requestID := mustPrivacyRequestID(t, integrationUUID(t, 2_521))
	receiptID := mustPrivacyReceiptID(t, integrationUUID(t, 2_721))
	service, err := privacyrequest.NewService(
		privacyStore,
		integrationPrivacyVerification{receiptID: receiptID},
		&integrationPrivacyExecution{},
		handoff,
	)
	if err != nil {
		t.Fatal(err)
	}
	submissionID := mustPrivacySubmissionID(t, integrationUUID(t, 2_621))
	if result, submitErr := service.Submit(ctx, scope, privacyrequest.SubmitCommand{
		SubmissionID: submissionID, RequestKind: privacyrequest.KindDeletion,
	}, requestID, 2_000); submitErr != nil || result.Kind != privacyrequest.ApplicationAccepted {
		t.Fatalf("Submit() = %#v, %v", result, submitErr)
	}
	if result, verifyErr := service.Verify(ctx, scope, requestID, 2_100); verifyErr != nil ||
		result.Request == nil || result.Request.Status != privacyrequest.StateReady {
		t.Fatalf("Verify() = %#v, %v", result, verifyErr)
	}
	processed, err := service.Process(ctx, scope, requestID, 2_200, 2_300)
	if err != nil || processed.Request == nil || processed.Request.Status != privacyrequest.StateCompleted ||
		processed.Request.Outcome != privacyrequest.OutcomeAccountDeletionStarted {
		t.Fatalf("Process() = %#v, %v", processed, err)
	}

	derived, err := privacydeletionadapter.DeriveStartIdentity(scope, requestID)
	if err != nil {
		t.Fatal(err)
	}
	snapshot, err := deletionStore.FindByOwner(ctx, derived.Scope)
	if err != nil || snapshot == nil || snapshot.Operation.OperationID != derived.OperationID ||
		len(snapshot.Receipts) != 0 {
		t.Fatalf("deletion snapshot = %#v, %v", snapshot, err)
	}
	if state, ok := snapshot.Operation.State.(accountdeletion.Ready); !ok ||
		state.Step != accountdeletion.StepRevokeSessions || state.Attempt != 0 {
		t.Fatalf("deletion state = %#v", snapshot.Operation.State)
	}
	assertPrivacyDeletionCounts(t, ctx, pool, 1, 1)
	if effects.calls != 0 {
		t.Fatalf("deletion effects called during handoff = %d", effects.calls)
	}

	// Models a lost handoff response: the exact owner/request derivation replays
	// the durable start instead of inserting or dispatching a second operation.
	replayed, err := handoff.StartExistingAccountDeletion(ctx, scope, requestID)
	if err != nil || replayed.Kind != privacyrequest.DeletionHandoffStarted {
		t.Fatalf("handoff replay = %#v, %v", replayed, err)
	}
	assertPrivacyDeletionCounts(t, ctx, pool, 1, 1)
	if effects.calls != 0 {
		t.Fatalf("deletion effects called during replay = %d", effects.calls)
	}
}

func TestPrivacyDeletionHandoffIsolatesSameRequestIDAcrossOwners(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	scopeA := seedPrivacyOwner(t, ctx, pool, 72)
	scopeB := seedPrivacyOwner(t, ctx, pool, 73)
	_, _, deletionService, effects := newPrivacyDeletionServices(t, pool)
	handoff, err := privacydeletionadapter.New(deletionService, func() int64 { return 3_000 })
	if err != nil {
		t.Fatal(err)
	}
	requestID := mustPrivacyRequestID(t, integrationUUID(t, 2_522))
	for _, scope := range []privacyrequest.Scope{scopeA, scopeB} {
		result, startErr := handoff.StartExistingAccountDeletion(ctx, scope, requestID)
		if startErr != nil || result.Kind != privacyrequest.DeletionHandoffStarted {
			t.Fatalf("StartExistingAccountDeletion(%#v) = %#v, %v", scope, result, startErr)
		}
	}
	derivedA, err := privacydeletionadapter.DeriveStartIdentity(scopeA, requestID)
	if err != nil {
		t.Fatal(err)
	}
	derivedB, err := privacydeletionadapter.DeriveStartIdentity(scopeB, requestID)
	if err != nil {
		t.Fatal(err)
	}
	if derivedA.OperationID == derivedB.OperationID ||
		derivedA.Command.IdempotencyKey == derivedB.Command.IdempotencyKey {
		t.Fatalf("owner derivations collided: A=%#v B=%#v", derivedA, derivedB)
	}
	assertPrivacyDeletionCounts(t, ctx, pool, 2, 2)
	if effects.calls != 0 {
		t.Fatalf("deletion effects called during isolated starts = %d", effects.calls)
	}
}

func TestPrivacyDeletionHandoffRejectsAConflictingOwnerOperation(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	scope := seedPrivacyOwner(t, ctx, pool, 74)
	_, deletionStore, deletionService, effects := newPrivacyDeletionServices(t, pool)
	deletionScope := accountdeletion.Scope{AccountID: scope.AccountID, VaultID: scope.VaultID}
	idempotencyKey, err := accountdeletion.ParseIdempotencyKey(strings.Repeat("I", 43))
	if err != nil {
		t.Fatal(err)
	}
	operationID, err := accountdeletion.ParseOperationID(integrationUUID(t, 2_923))
	if err != nil {
		t.Fatal(err)
	}
	started, err := deletionService.Start(
		ctx,
		deletionScope,
		accountdeletion.StartCommand{IdempotencyKey: idempotencyKey},
		operationID,
		3_500,
	)
	if err != nil || started.Kind != accountdeletion.ApplicationAccepted {
		t.Fatalf("conflicting Start() = %#v, %v", started, err)
	}
	handoff, err := privacydeletionadapter.New(deletionService, func() int64 { return 3_600 })
	if err != nil {
		t.Fatal(err)
	}
	result, err := handoff.StartExistingAccountDeletion(
		ctx,
		scope,
		mustPrivacyRequestID(t, integrationUUID(t, 2_523)),
	)
	if err != nil || result.Kind != privacyrequest.DeletionHandoffFailed || result.Retryable ||
		result.FailureCode != privacyrequest.FailureCode("account-deletion-conflict") {
		t.Fatalf("conflicting handoff = %#v, %v", result, err)
	}
	snapshot, err := deletionStore.FindByOwner(ctx, deletionScope)
	if err != nil || snapshot == nil || snapshot.Operation.OperationID != operationID {
		t.Fatalf("preserved conflicting operation = %#v, %v", snapshot, err)
	}
	assertPrivacyDeletionCounts(t, ctx, pool, 1, 1)
	if effects.calls != 0 {
		t.Fatalf("deletion effects called during conflict = %d", effects.calls)
	}
}

func newPrivacyDeletionServices(
	t *testing.T,
	pool *pgxpool.Pool,
) (*postgresadapter.PrivacyRequestStore, *postgresadapter.AccountDeletionStore, *accountdeletion.Service, *privacyDeletionEffects) {
	t.Helper()
	privacyStore, err := postgresadapter.NewPrivacyRequestStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	deletionStore, err := postgresadapter.NewAccountDeletionStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	credentials, err := accountdeletioncredential.New([]byte(strings.Repeat("K", 32)))
	if err != nil {
		t.Fatal(err)
	}
	effects := &privacyDeletionEffects{}
	service, err := accountdeletion.NewService(accountdeletion.ServiceOptions{
		Repository: deletionStore, Credentials: credentials,
		Sessions: effects, Subscriptions: effects, VaultData: effects,
		PrivateObjects: effects, Accounts: effects,
		ContinuationLifetime: 60_000, LeaseDuration: 1_000,
		RetryPolicy: accountdeletion.RetryPolicy{DelaysMilli: []int64{100}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return privacyStore, deletionStore, service, effects
}

type privacyDeletionEffects struct{ calls int }

func (effects *privacyDeletionEffects) RevokeSessions(
	context.Context,
	accountdeletion.StepEffectInput,
) (accountdeletion.StepEffectResult, error) {
	effects.calls++
	return accountdeletion.StepEffectResult{Kind: accountdeletion.EffectSucceeded}, nil
}

func (effects *privacyDeletionEffects) CancelSubscriptionImmediately(
	context.Context,
	accountdeletion.StepEffectInput,
) (accountdeletion.StepEffectResult, error) {
	effects.calls++
	return accountdeletion.StepEffectResult{Kind: accountdeletion.EffectSucceeded}, nil
}

func (effects *privacyDeletionEffects) DeleteVaultData(
	context.Context,
	accountdeletion.StepEffectInput,
) (accountdeletion.StepEffectResult, error) {
	effects.calls++
	return accountdeletion.StepEffectResult{Kind: accountdeletion.EffectSucceeded}, nil
}

func (effects *privacyDeletionEffects) DeletePrivateObjects(
	context.Context,
	accountdeletion.StepEffectInput,
) (accountdeletion.StepEffectResult, error) {
	effects.calls++
	return accountdeletion.StepEffectResult{Kind: accountdeletion.EffectSucceeded}, nil
}

func (effects *privacyDeletionEffects) FinalizeAccount(
	context.Context,
	accountdeletion.StepEffectInput,
) (accountdeletion.StepEffectResult, error) {
	effects.calls++
	return accountdeletion.StepEffectResult{Kind: accountdeletion.EffectSucceeded}, nil
}

func assertPrivacyDeletionCounts(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	wantOperations int,
	wantContinuations int,
) {
	t.Helper()
	var operations int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM account_deletion_operations").Scan(&operations); err != nil {
		t.Fatal(err)
	}
	var continuations int
	if err := pool.QueryRow(ctx, "SELECT count(*) FROM account_deletion_continuations").Scan(&continuations); err != nil {
		t.Fatal(err)
	}
	if operations != wantOperations || continuations != wantContinuations {
		t.Fatalf("deletion rows = operations %d/%d, continuations %d/%d", operations, wantOperations, continuations, wantContinuations)
	}
}
