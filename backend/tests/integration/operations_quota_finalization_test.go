//go:build integration

package integration_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/fukamu/notes/backend/internal/quota"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestOperationsQuotaCommitRequiresDurableMatchingSyncEvidencePostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultContext := seedEntitlementOwner(t, ctx, pool, 183, 283, 383)
	otherContext := seedEntitlementOwner(t, ctx, pool, 184, 284, 384)
	ledger := openQuotaLedger(t, ctx, quotaDirectory(t, pool), vaultContext, 1_000)
	otherLedger := openQuotaLedger(t, ctx, quotaDirectory(t, pool), otherContext, 1_000)
	limits := entitlement.PaidPersonalVaultLimits()
	store, err := postgresadapter.NewQuotaCommitStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	service, err := operations.NewQuotaCommitService(store)
	if err != nil {
		t.Fatal(err)
	}

	committedCommand := reserveQuotaForOperations(
		t, ctx, ledger, vaultContext, 945, 995, 2_000, 4_000, limits,
	)
	seedQuotaCommitReceipt(t, ctx, pool, vaultContext, committedCommand, "", 0)
	commit := quotaOperationsCommit(vaultContext, committedCommand, 5_000)
	result, err := service.Commit(ctx, commit)
	if err != nil || result.Kind != operations.QuotaCommitCommitted || result.FinalizedAt != 5_000 {
		t.Fatalf("commit = %#v, %v", result, err)
	}
	committedSnapshot, err := ledger.Snapshot(ctx)
	if err != nil || committedSnapshot.Revision != 2 ||
		committedSnapshot.Committed != (quota.Usage{ActiveCards: 1, PlaintextBytes: 10}) {
		t.Fatalf("committed snapshot = %#v, %v", committedSnapshot, err)
	}
	replayed, err := service.Commit(ctx, commit)
	if err != nil || replayed.Kind != operations.QuotaCommitReplayed || replayed.FinalizedAt != 5_000 {
		t.Fatalf("replay = %#v, %v", replayed, err)
	}
	afterReplay, err := ledger.Snapshot(ctx)
	if err != nil || afterReplay != committedSnapshot {
		t.Fatalf("replay snapshot = %#v, %v", afterReplay, err)
	}

	concurrentCommand := reserveQuotaForOperations(
		t, ctx, ledger, vaultContext, 946, 996, 6_000, 7_000, limits,
	)
	seedQuotaCommitReceipt(t, ctx, pool, vaultContext, concurrentCommand, "", 0)
	concurrentCommit := quotaOperationsCommit(vaultContext, concurrentCommand, 8_000)
	type commitOutcome struct {
		result operations.QuotaCommitResult
		err    error
	}
	outcomes := make(chan commitOutcome, 2)
	var start sync.WaitGroup
	start.Add(1)
	for range 2 {
		go func() {
			start.Wait()
			result, err := service.Commit(ctx, concurrentCommit)
			outcomes <- commitOutcome{result: result, err: err}
		}()
	}
	start.Done()
	committedCount, replayedCount := 0, 0
	for range 2 {
		outcome := <-outcomes
		if outcome.err != nil {
			t.Fatalf("concurrent commit error = %v", outcome.err)
		}
		switch outcome.result.Kind {
		case operations.QuotaCommitCommitted:
			committedCount++
		case operations.QuotaCommitReplayed:
			replayedCount++
		default:
			t.Fatalf("concurrent commit = %#v", outcome.result)
		}
	}
	if committedCount != 1 || replayedCount != 1 {
		t.Fatalf("concurrent outcomes committed=%d replayed=%d", committedCount, replayedCount)
	}
	concurrentSnapshot, err := ledger.Snapshot(ctx)
	if err != nil || concurrentSnapshot.Revision != 3 ||
		concurrentSnapshot.Committed != (quota.Usage{ActiveCards: 2, PlaintextBytes: 20}) {
		t.Fatalf("concurrent snapshot = %#v, %v", concurrentSnapshot, err)
	}

	missingCommand := reserveQuotaForOperations(
		t, ctx, ledger, vaultContext, 947, 997, 9_000, 10_000, limits,
	)
	assertQuotaCommitRefusedWithoutMutation(
		t, ctx, service, ledger, quotaOperationsCommit(vaultContext, missingCommand, 11_000),
		operations.QuotaCommitEvidenceMissing,
	)

	mismatchCommand := reserveQuotaForOperations(
		t, ctx, ledger, vaultContext, 948, 998, 12_000, 13_000, limits,
	)
	seedQuotaCommitReceipt(
		t, ctx, pool, vaultContext, mismatchCommand,
		string(integrationQuotaFingerprint(t, "different-sync-evidence")), 0,
	)
	assertQuotaCommitRefusedWithoutMutation(
		t, ctx, service, ledger, quotaOperationsCommit(vaultContext, mismatchCommand, 14_000),
		operations.QuotaCommitEvidenceMismatch,
	)

	notDueCommand := reserveQuotaForOperations(
		t, ctx, ledger, vaultContext, 949, 999, 15_000, 17_000, limits,
	)
	seedQuotaCommitReceipt(t, ctx, pool, vaultContext, notDueCommand, "", 0)
	assertQuotaCommitRefusedWithoutMutation(
		t, ctx, service, ledger, quotaOperationsCommit(vaultContext, notDueCommand, 16_999),
		operations.QuotaCommitNotDue,
	)

	removedEvidenceCommand := reserveQuotaForOperations(
		t, ctx, ledger, vaultContext, 952, 1_002, 17_100, 17_200, limits,
	)
	seedQuotaCommitReceipt(t, ctx, pool, vaultContext, removedEvidenceCommand, "", 0)
	removingRepository := &removingQuotaEvidenceRepository{
		store: store, pool: pool, command: quotaOperationsCommit(vaultContext, removedEvidenceCommand, 17_300),
	}
	removingService, err := operations.NewQuotaCommitService(removingRepository)
	if err != nil {
		t.Fatal(err)
	}
	assertQuotaCommitRefusedWithoutMutation(
		t, ctx, removingService, ledger, removingRepository.command, operations.QuotaCommitConflict,
	)

	releasedCommand := reserveQuotaForOperations(
		t, ctx, ledger, vaultContext, 950, 1_000, 18_000, 19_000, limits,
	)
	seedQuotaCommitReceipt(t, ctx, pool, vaultContext, releasedCommand, "", 0)
	if released, err := ledger.Finalize(ctx, quota.FinalizationCommand{
		ReservationID: releasedCommand.ReservationID,
		Fingerprint:   releasedCommand.Fingerprint,
		Outcome:       quota.FinalizationRelease,
		Limits:        limits,
		FinalizedAt:   20_000,
	}); err != nil || released.Kind != quota.FinalizationReleased {
		t.Fatalf("release = %#v, %v", released, err)
	}
	assertQuotaCommitRefusedWithoutMutation(
		t, ctx, service, ledger, quotaOperationsCommit(vaultContext, releasedCommand, 21_000),
		operations.QuotaCommitAlreadyReleased,
	)

	otherCommand := reserveQuotaForOperations(
		t, ctx, otherLedger, otherContext, 951, 1_001, 22_000, 23_000, limits,
	)
	seedQuotaCommitReceipt(t, ctx, pool, otherContext, otherCommand, "", 0)
	crossOwner := quotaOperationsCommit(otherContext, otherCommand, 24_000)
	crossOwner.AccountID = vaultContext.AccountID
	assertQuotaCommitRefusedWithoutMutation(
		t, ctx, service, otherLedger, crossOwner, operations.QuotaCommitOwnerMismatch,
	)

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := service.Commit(cancelled, commit); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled commit error = %v", err)
	}
}

func reserveQuotaForOperations(
	t *testing.T,
	ctx context.Context,
	ledger quota.Ledger,
	vaultContext identity.VaultContext,
	reservationSuffix int,
	cardSuffix int,
	requestedAt int64,
	reconcileAfter int64,
	limits entitlement.PersonalVaultLimits,
) quota.ReservationCommand {
	t.Helper()
	command := integrationQuotaCommand(t, reservationSuffix, cardSuffix, quota.Change{
		Kind: quota.ChangeCreate, NextPlaintextBytes: 10,
	}, limits, requestedAt, reconcileAfter)
	result, err := ledger.Reserve(ctx, command)
	if err != nil || result.Kind != quota.ReservationApplied {
		t.Fatalf("reserve operations candidate = %#v, %v", result, err)
	}
	if vaultContext.AccountID == "" || vaultContext.VaultID == "" {
		t.Fatal("invalid operations owner")
	}
	return command
}

func seedQuotaCommitReceipt(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	vaultContext identity.VaultContext,
	command quota.ReservationCommand,
	fingerprint string,
	committedAt int64,
) {
	t.Helper()
	if fingerprint == "" {
		fingerprint = string(command.Fingerprint)
	}
	if committedAt == 0 {
		committedAt = command.RequestedAt
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_sync_v2_commits(
		account_id, vault_id, mutation_id, fingerprint, card_id, applied_revision, committed_at
	) VALUES ($1, $2, $3, $4, $5, 1, $6)`,
		string(vaultContext.AccountID), string(vaultContext.VaultID), string(command.ReservationID),
		fingerprint, string(command.CardID), committedAt,
	); err != nil {
		t.Fatal(err)
	}
}

func quotaOperationsCommit(
	vaultContext identity.VaultContext,
	command quota.ReservationCommand,
	finalizedAt int64,
) operations.QuotaCommitCommand {
	return operations.QuotaCommitCommand{
		AccountID: vaultContext.AccountID, VaultID: vaultContext.VaultID,
		ReservationID: command.ReservationID, FinalizedAt: finalizedAt,
	}
}

func assertQuotaCommitRefusedWithoutMutation(
	t *testing.T,
	ctx context.Context,
	service *operations.QuotaCommitService,
	ledger quota.Ledger,
	command operations.QuotaCommitCommand,
	reason operations.QuotaCommitRefusal,
) {
	t.Helper()
	before, err := ledger.Snapshot(ctx)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Commit(ctx, command)
	if err != nil || result.Kind != operations.QuotaCommitRefused || result.Reason != reason {
		t.Fatalf("refused quota commit = %#v, %v", result, err)
	}
	after, err := ledger.Snapshot(ctx)
	if err != nil || after != before {
		t.Fatalf("refusal changed quota: before=%#v after=%#v error=%v", before, after, err)
	}
}

type removingQuotaEvidenceRepository struct {
	store   *postgresadapter.QuotaCommitStore
	pool    *pgxpool.Pool
	command operations.QuotaCommitCommand
}

func (repository *removingQuotaEvidenceRepository) InspectQuotaCommit(
	ctx context.Context,
	command operations.QuotaCommitCommand,
) (operations.QuotaCommitEvidence, error) {
	return repository.store.InspectQuotaCommit(ctx, command)
}

func (repository *removingQuotaEvidenceRepository) FinalizeQuotaCommit(
	ctx context.Context,
	scope quota.Scope,
	command quota.FinalizationCommand,
) (quota.FinalizationResult, error) {
	if _, err := repository.pool.Exec(ctx, `DELETE FROM vault_sync_v2_commits
		WHERE account_id = $1 AND vault_id = $2 AND mutation_id = $3`,
		string(repository.command.AccountID), string(repository.command.VaultID),
		string(repository.command.ReservationID),
	); err != nil {
		return quota.FinalizationResult{}, err
	}
	return repository.store.FinalizeQuotaCommit(ctx, scope, command)
}
