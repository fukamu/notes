//go:build integration

package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"sync"
	"testing"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/quota"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestQuotaLedgerLifecycleReplayOwnershipAndDecreasesPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultContext := seedEntitlementOwner(t, ctx, pool, 141, 241, 341)
	otherContext := seedEntitlementOwner(t, ctx, pool, 142, 242, 342)
	directory := quotaDirectory(t, pool)

	wrongOwner := otherContext
	wrongOwner.VaultID = vaultContext.VaultID
	if opened, err := directory.Open(ctx, wrongOwner, 1_000); err != nil || opened.Kind != quota.LedgerOwnerMismatch {
		t.Fatalf("wrong owner open = %#v, %v", opened, err)
	}
	ledger := openQuotaLedger(t, ctx, directory, vaultContext, 1_000)
	otherLedger := openQuotaLedger(t, ctx, directory, otherContext, 1_000)
	if snapshot, err := ledger.Snapshot(ctx); err != nil || snapshot.Revision != 1 || snapshot.Effective != (quota.Usage{}) {
		t.Fatalf("initial snapshot = %#v, %v", snapshot, err)
	}

	create := integrationQuotaCommand(t, 901, 951, quota.Change{
		Kind: quota.ChangeCreate, NextPlaintextBytes: 10,
	}, entitlement.PaidPersonalVaultLimits(), 2_000, 3_000)
	reserved, err := ledger.Reserve(ctx, create)
	if err != nil || reserved.Kind != quota.ReservationApplied || reserved.Reservation == nil ||
		reserved.Snapshot == nil || reserved.Snapshot.Reserved != (quota.Usage{ActiveCards: 1, PlaintextBytes: 10}) {
		t.Fatalf("reserve create = %#v, %v", reserved, err)
	}
	replayed, err := ledger.Reserve(ctx, create)
	if err != nil || replayed.Kind != quota.ReservationReplayed {
		t.Fatalf("reserve replay = %#v, %v", replayed, err)
	}
	reused := create
	reused.Fingerprint = integrationQuotaFingerprint(t, "different-create")
	if result, err := ledger.Reserve(ctx, reused); err != nil || result.Kind != quota.ReservationRejected ||
		result.Reason != quota.RejectionIdempotencyKeyReuse {
		t.Fatalf("reservation key reuse = %#v, %v", result, err)
	}
	if found, err := otherLedger.FindReservation(ctx, create.ReservationID); err != nil || found != nil {
		t.Fatalf("cross-owner find = %#v, %v", found, err)
	}

	commit := quota.FinalizationCommand{
		ReservationID: create.ReservationID, Fingerprint: create.Fingerprint,
		Outcome: quota.FinalizationCommit, Limits: create.Limits, FinalizedAt: 4_000,
	}
	committed, err := ledger.Finalize(ctx, commit)
	if err != nil || committed.Kind != quota.FinalizationCommitted || committed.Snapshot == nil ||
		committed.Snapshot.Committed != (quota.Usage{ActiveCards: 1, PlaintextBytes: 10}) ||
		committed.Snapshot.Reserved != (quota.Usage{}) {
		t.Fatalf("commit create = %#v, %v", committed, err)
	}
	if replay, err := ledger.Finalize(ctx, commit); err != nil || replay.Kind != quota.FinalizationReplayed {
		t.Fatalf("finalization replay = %#v, %v", replay, err)
	}
	if replay, err := ledger.Reserve(ctx, create); err != nil || replay.Kind != quota.ReservationReplayed ||
		replay.Reservation == nil || replay.Reservation.State.Kind != quota.ReservationCommitted {
		t.Fatalf("reservation replay after commit = %#v, %v", replay, err)
	}
	wrongFingerprint := commit
	wrongFingerprint.Fingerprint = integrationQuotaFingerprint(t, "wrong-finalize")
	if result, err := ledger.Finalize(ctx, wrongFingerprint); err != nil ||
		result.Kind != quota.FinalizationRejected || result.Reason != quota.RejectionIdempotencyKeyReuse {
		t.Fatalf("finalization key reuse = %#v, %v", result, err)
	}

	decrease := integrationQuotaCommand(t, 902, 951, quota.Change{
		Kind: quota.ChangeUpdate, CurrentPlaintextBytes: 10, NextPlaintextBytes: 4,
	}, create.Limits, 5_000, 6_000)
	decreaseReserved, err := ledger.Reserve(ctx, decrease)
	if err != nil || decreaseReserved.Kind != quota.ReservationApplied || decreaseReserved.Snapshot == nil ||
		decreaseReserved.Snapshot.Effective != (quota.Usage{ActiveCards: 1, PlaintextBytes: 10}) {
		t.Fatalf("reserve decrease = %#v, %v", decreaseReserved, err)
	}
	decreased, err := ledger.Finalize(ctx, quota.FinalizationCommand{
		ReservationID: decrease.ReservationID, Fingerprint: decrease.Fingerprint,
		Outcome: quota.FinalizationCommit, Limits: decrease.Limits, FinalizedAt: 7_000,
	})
	if err != nil || decreased.Kind != quota.FinalizationCommitted || decreased.Snapshot == nil ||
		decreased.Snapshot.Committed != (quota.Usage{ActiveCards: 1, PlaintextBytes: 4}) {
		t.Fatalf("finalize decrease = %#v, %v", decreased, err)
	}

	deletion := integrationQuotaCommand(t, 903, 951, quota.Change{
		Kind: quota.ChangeDelete, CurrentPlaintextBytes: 4,
	}, create.Limits, 8_000, 9_000)
	if result, err := ledger.Reserve(ctx, deletion); err != nil || result.Kind != quota.ReservationApplied ||
		result.Snapshot == nil || result.Snapshot.Effective != (quota.Usage{ActiveCards: 1, PlaintextBytes: 4}) {
		t.Fatalf("reserve deletion = %#v, %v", result, err)
	}
	deleted, err := ledger.Finalize(ctx, quota.FinalizationCommand{
		ReservationID: deletion.ReservationID, Fingerprint: deletion.Fingerprint,
		Outcome: quota.FinalizationCommit, Limits: deletion.Limits, FinalizedAt: 10_000,
	})
	if err != nil || deleted.Kind != quota.FinalizationCommitted || deleted.Snapshot == nil ||
		deleted.Snapshot.Committed != (quota.Usage{}) {
		t.Fatalf("finalize deletion = %#v, %v", deleted, err)
	}

	release := integrationQuotaCommand(t, 904, 952, quota.Change{
		Kind: quota.ChangeCreate, NextPlaintextBytes: 7,
	}, create.Limits, 11_000, 12_000)
	if result, err := ledger.Reserve(ctx, release); err != nil || result.Kind != quota.ReservationApplied {
		t.Fatalf("reserve release = %#v, %v", result, err)
	}
	released, err := ledger.Finalize(ctx, quota.FinalizationCommand{
		ReservationID: release.ReservationID, Fingerprint: release.Fingerprint,
		Outcome: quota.FinalizationRelease, Limits: release.Limits, FinalizedAt: 13_000,
	})
	if err != nil || released.Kind != quota.FinalizationReleased || released.Snapshot == nil ||
		released.Snapshot.Committed != (quota.Usage{}) || released.Snapshot.Reserved != (quota.Usage{}) {
		t.Fatalf("release = %#v, %v", released, err)
	}
	assertQuotaSchema(t, ctx, pool)
}

func TestQuotaLedgerConcurrentAdmissionAndFinalizationPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	directory := quotaDirectory(t, pool)
	cardContext := seedEntitlementOwner(t, ctx, pool, 151, 251, 351)
	cardLedger := openQuotaLedger(t, ctx, directory, cardContext, 1_000)
	cardLimits := entitlement.PaidPersonalVaultLimits()
	if _, err := pool.Exec(
		ctx,
		"UPDATE vault_quota_usage SET active_cards = $1 WHERE account_id = $2 AND vault_id = $3",
		cardLimits.ActiveCards-1, string(cardContext.AccountID), string(cardContext.VaultID),
	); err != nil {
		t.Fatal(err)
	}
	cardResults := reserveConcurrently(t, ctx, cardLedger,
		integrationQuotaCommand(t, 911, 961, quota.Change{Kind: quota.ChangeCreate}, cardLimits, 2_000, 3_000),
		integrationQuotaCommand(t, 912, 962, quota.Change{Kind: quota.ChangeCreate}, cardLimits, 2_001, 3_001),
	)
	assertOneQuotaAdmission(t, cardResults, quota.RejectionActiveCardLimit)

	byteContext := seedEntitlementOwner(t, ctx, pool, 152, 252, 352)
	byteLedger := openQuotaLedger(t, ctx, directory, byteContext, 1_000)
	byteLimits := entitlement.PaidPersonalVaultLimits()
	if _, err := pool.Exec(
		ctx,
		"UPDATE vault_quota_usage SET plaintext_bytes = $1 WHERE account_id = $2 AND vault_id = $3",
		byteLimits.PlaintextBytesPerVault-5, string(byteContext.AccountID), string(byteContext.VaultID),
	); err != nil {
		t.Fatal(err)
	}
	byteResults := reserveConcurrently(t, ctx, byteLedger,
		integrationQuotaCommand(t, 913, 963, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 4}, byteLimits, 2_000, 3_000),
		integrationQuotaCommand(t, 914, 964, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 4}, byteLimits, 2_001, 3_001),
	)
	assertOneQuotaAdmission(t, byteResults, quota.RejectionVaultPlaintextLimit)

	finalizeContext := seedEntitlementOwner(t, ctx, pool, 153, 253, 353)
	finalizeLedger := openQuotaLedger(t, ctx, directory, finalizeContext, 1_000)
	limits := entitlement.PersonalVaultLimits{
		ActiveCards: 10, DisplayCharactersPerCard: 1_000,
		SerializedPlaintextBytesPerCard: 8_192, PlaintextBytesPerVault: 100,
	}
	first := integrationQuotaCommand(t, 915, 965, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 10}, limits, 2_000, 3_000)
	second := integrationQuotaCommand(t, 916, 966, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 20}, limits, 2_001, 3_001)
	for _, command := range []quota.ReservationCommand{first, second} {
		if result, err := finalizeLedger.Reserve(ctx, command); err != nil || result.Kind != quota.ReservationApplied {
			t.Fatalf("reserve before concurrent finalize = %#v, %v", result, err)
		}
	}
	type finalizationOutcome struct {
		result quota.FinalizationResult
		err    error
	}
	finalizations := make(chan finalizationOutcome, 2)
	var start sync.WaitGroup
	start.Add(1)
	for index, command := range []quota.ReservationCommand{first, second} {
		index, command := index, command
		go func() {
			start.Wait()
			result, err := finalizeLedger.Finalize(ctx, quota.FinalizationCommand{
				ReservationID: command.ReservationID, Fingerprint: command.Fingerprint,
				Outcome: quota.FinalizationCommit, Limits: limits, FinalizedAt: 4_000 + int64(index),
			})
			finalizations <- finalizationOutcome{result: result, err: err}
		}()
	}
	start.Done()
	for range 2 {
		outcome := <-finalizations
		if outcome.err != nil || outcome.result.Kind != quota.FinalizationCommitted {
			t.Fatalf("concurrent finalization = %#v, %v", outcome.result, outcome.err)
		}
	}
	snapshot, err := finalizeLedger.Snapshot(ctx)
	if err != nil || snapshot.Committed != (quota.Usage{ActiveCards: 2, PlaintextBytes: 30}) ||
		snapshot.Reserved != (quota.Usage{}) || snapshot.Revision != 3 {
		t.Fatalf("concurrent final snapshot = %#v, %v", snapshot, err)
	}
}

func TestQuotaLedgerFinalizationCASRollbackPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultContext := seedEntitlementOwner(t, ctx, pool, 161, 261, 361)
	ledger := openQuotaLedger(t, ctx, quotaDirectory(t, pool), vaultContext, 1_000)
	command := integrationQuotaCommand(t, 921, 971, quota.Change{
		Kind: quota.ChangeCreate, NextPlaintextBytes: 10,
	}, entitlement.PaidPersonalVaultLimits(), 2_000, 3_000)
	if result, err := ledger.Reserve(ctx, command); err != nil || result.Kind != quota.ReservationApplied {
		t.Fatalf("reserve = %#v, %v", result, err)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION suppress_quota_reservation_update() RETURNS trigger
		LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER suppress_quota_reservation_update
		BEFORE UPDATE OF state ON vault_quota_reservations
		FOR EACH ROW EXECUTE FUNCTION suppress_quota_reservation_update()`); err != nil {
		t.Fatal(err)
	}
	result, err := ledger.Finalize(ctx, quota.FinalizationCommand{
		ReservationID: command.ReservationID, Fingerprint: command.Fingerprint,
		Outcome: quota.FinalizationCommit, Limits: command.Limits, FinalizedAt: 4_000,
	})
	if err != nil || result.Kind != quota.FinalizationRejected || result.Reason != quota.RejectionCASConflict {
		t.Fatalf("suppressed finalization = %#v, %v", result, err)
	}
	snapshot, err := ledger.Snapshot(ctx)
	if err != nil || snapshot.Committed != (quota.Usage{}) ||
		snapshot.Reserved != (quota.Usage{ActiveCards: 1, PlaintextBytes: 10}) || snapshot.Revision != 1 {
		t.Fatalf("rolled back snapshot = %#v, %v", snapshot, err)
	}
	reservation, err := ledger.FindReservation(ctx, command.ReservationID)
	if err != nil || reservation == nil || reservation.State.Kind != quota.ReservationReserved {
		t.Fatalf("rolled back reservation = %#v, %v", reservation, err)
	}
	if _, err := pool.Exec(ctx, "DROP TRIGGER suppress_quota_reservation_update ON vault_quota_reservations"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DROP FUNCTION suppress_quota_reservation_update()"); err != nil {
		t.Fatal(err)
	}
	if result, err := ledger.Finalize(ctx, quota.FinalizationCommand{
		ReservationID: command.ReservationID, Fingerprint: command.Fingerprint,
		Outcome: quota.FinalizationCommit, Limits: command.Limits, FinalizedAt: 4_001,
	}); err != nil || result.Kind != quota.FinalizationCommitted {
		t.Fatalf("recovered finalization = %#v, %v", result, err)
	}
	var assertions int
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM vault_quota_finalization_assertions").Scan(&assertions); err != nil || assertions != 0 {
		t.Fatalf("assertion rows = %d, %v", assertions, err)
	}
}

func TestQuotaLedgerReconciliationCandidatesAndMalformedRowsPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultContext := seedEntitlementOwner(t, ctx, pool, 171, 271, 371)
	otherContext := seedEntitlementOwner(t, ctx, pool, 172, 272, 372)
	directory := quotaDirectory(t, pool)
	ledger := openQuotaLedger(t, ctx, directory, vaultContext, 1_000)
	otherLedger := openQuotaLedger(t, ctx, directory, otherContext, 1_000)
	limits := entitlement.PaidPersonalVaultLimits()
	commands := []quota.ReservationCommand{
		integrationQuotaCommand(t, 933, 983, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 1}, limits, 2_000, 5_000),
		integrationQuotaCommand(t, 932, 982, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 1}, limits, 2_001, 4_000),
		integrationQuotaCommand(t, 931, 981, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 1}, limits, 2_002, 4_000),
	}
	for _, command := range commands {
		if result, err := ledger.Reserve(ctx, command); err != nil || result.Kind != quota.ReservationApplied {
			t.Fatalf("reserve candidate = %#v, %v", result, err)
		}
	}
	candidates, err := ledger.ListReconciliationCandidates(ctx, 5_000, 2)
	if err != nil || len(candidates) != 2 ||
		candidates[0].ReservationID != commands[2].ReservationID ||
		candidates[1].ReservationID != commands[1].ReservationID {
		t.Fatalf("ordered candidates = %#v, %v", candidates, err)
	}
	if candidates, err := otherLedger.ListReconciliationCandidates(ctx, 5_000, 100); err != nil || len(candidates) != 0 {
		t.Fatalf("cross-owner candidates = %#v, %v", candidates, err)
	}
	if _, err := ledger.ListReconciliationCandidates(ctx, 5_000, 101); !errors.Is(err, postgresadapter.ErrInvalidQuotaOperation) {
		t.Fatalf("oversized candidate page error = %v", err)
	}
	unchanged, err := ledger.Snapshot(ctx)
	if err != nil || unchanged.Reserved != (quota.Usage{ActiveCards: 3, PlaintextBytes: 3}) {
		t.Fatalf("candidate listing changed quota = %#v, %v", unchanged, err)
	}

	if _, err := pool.Exec(ctx, "ALTER TABLE vault_quota_reservations DROP CONSTRAINT vault_quota_reservations_shape_check"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE vault_quota_reservations SET fingerprint = 'invalid' WHERE account_id = $1 AND vault_id = $2 AND reservation_id = $3",
		string(vaultContext.AccountID), string(vaultContext.VaultID), string(commands[0].ReservationID),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := ledger.FindReservation(ctx, commands[0].ReservationID); !errors.Is(err, postgresadapter.ErrInvalidQuotaRecord) {
		t.Fatalf("malformed reservation error = %v", err)
	}
}

type quotaReservationOutcome struct {
	result quota.ReservationResult
	err    error
}

func reserveConcurrently(
	t *testing.T,
	ctx context.Context,
	ledger quota.Ledger,
	commands ...quota.ReservationCommand,
) []quotaReservationOutcome {
	t.Helper()
	outcomes := make(chan quotaReservationOutcome, len(commands))
	var start sync.WaitGroup
	start.Add(1)
	for _, command := range commands {
		command := command
		go func() {
			start.Wait()
			result, err := ledger.Reserve(ctx, command)
			outcomes <- quotaReservationOutcome{result: result, err: err}
		}()
	}
	start.Done()
	results := make([]quotaReservationOutcome, 0, len(commands))
	for range commands {
		results = append(results, <-outcomes)
	}
	return results
}

func assertOneQuotaAdmission(
	t *testing.T,
	outcomes []quotaReservationOutcome,
	rejectedReason quota.RejectionReason,
) {
	t.Helper()
	applied, rejected := 0, 0
	for _, outcome := range outcomes {
		if outcome.err != nil {
			t.Fatalf("admission error = %v", outcome.err)
		}
		switch outcome.result.Kind {
		case quota.ReservationApplied:
			applied++
		case quota.ReservationRejected:
			if outcome.result.Reason != rejectedReason {
				t.Fatalf("admission rejection = %#v", outcome.result)
			}
			rejected++
		default:
			t.Fatalf("unexpected admission = %#v", outcome.result)
		}
	}
	if applied != 1 || rejected != 1 {
		t.Fatalf("admission counts applied=%d rejected=%d", applied, rejected)
	}
}

func quotaDirectory(t *testing.T, pool *pgxpool.Pool) *postgresadapter.QuotaLedgerDirectory {
	t.Helper()
	directory, err := postgresadapter.NewQuotaLedgerDirectory(pool)
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func openQuotaLedger(
	t *testing.T,
	ctx context.Context,
	directory *postgresadapter.QuotaLedgerDirectory,
	vaultContext identity.VaultContext,
	initializedAt int64,
) quota.Ledger {
	t.Helper()
	result, err := directory.Open(ctx, vaultContext, initializedAt)
	if err != nil || result.Kind != quota.LedgerOpened || result.Ledger == nil {
		t.Fatalf("open ledger = %#v, %v", result, err)
	}
	return result.Ledger
}

func integrationQuotaCommand(
	t *testing.T,
	reservationSuffix int,
	cardSuffix int,
	change quota.Change,
	limits entitlement.PersonalVaultLimits,
	requestedAt int64,
	reconcileAfter int64,
) quota.ReservationCommand {
	t.Helper()
	reservationID, err := quota.ParseReservationID(integrationUUID(t, reservationSuffix))
	if err != nil {
		t.Fatal(err)
	}
	cardID, err := quota.ParseCardID(integrationUUID(t, cardSuffix))
	if err != nil {
		t.Fatal(err)
	}
	return quota.ReservationCommand{
		ReservationID: reservationID,
		Fingerprint:   integrationQuotaFingerprint(t, string(reservationID)),
		CardID:        cardID, Change: change, Limits: limits,
		RequestedAt: requestedAt, ReconcileAfter: reconcileAfter,
	}
}

func integrationQuotaFingerprint(t *testing.T, value string) quota.Fingerprint {
	t.Helper()
	digest := sha256.Sum256([]byte(value))
	fingerprint, err := quota.ParseFingerprint(base64.RawURLEncoding.EncodeToString(digest[:]))
	if err != nil {
		t.Fatal(err)
	}
	return fingerprint
}

func assertQuotaSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, table := range []string{
		"vault_quota_usage", "vault_quota_reservations", "vault_quota_finalization_assertions",
	} {
		var exists bool
		if err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", "public."+table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatalf("missing quota table %s", table)
		}
	}
	var indexExists bool
	if err := pool.QueryRow(
		ctx,
		"SELECT to_regclass('idx_vault_quota_reservations_reconcile') IS NOT NULL",
	).Scan(&indexExists); err != nil || !indexExists {
		t.Fatalf("reconciliation index exists = %v, %v", indexExists, err)
	}
}
