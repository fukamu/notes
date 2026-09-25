//go:build integration

package integration_test

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"fmt"
	"sync"
	"testing"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/syncv2"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestSyncV2JournalLifecycleReplayIsolationAndPagingPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	contextA := seedEntitlementOwner(t, ctx, pool, 171, 271, 371)
	contextB := seedEntitlementOwner(t, ctx, pool, 172, 272, 372)
	directory := syncV2Directory(t, pool)

	wrongOwner := contextB
	wrongOwner.VaultID = contextA.VaultID
	if opened, err := directory.Open(ctx, wrongOwner); err != nil || opened.Kind != syncv2.JournalOwnerMismatch {
		t.Fatalf("wrong owner open = %#v, %v", opened, err)
	}
	repositoryA := openSyncV2Journal(t, ctx, directory, contextA)
	repositoryB := openSyncV2Journal(t, ctx, directory, contextB)

	cardA := integrationSyncV2CardID(t, 1)
	cardB := integrationSyncV2CardID(t, 2)
	conflict := integrationSyncV2ConflictID(t, 3)
	createA := integrationSyncV2Create(t, 101, cardA, 1_100)
	created, err := repositoryA.Commit(ctx, createA)
	if err != nil || created.Kind != syncv2.CommitApplied || created.Receipt == nil || created.Receipt.AppliedRevision != 1 {
		t.Fatalf("create = %#v, %v", created, err)
	}
	if replay, err := repositoryA.Commit(ctx, createA); err != nil || replay.Kind != syncv2.CommitReplayed {
		t.Fatalf("replay = %#v, %v", replay, err)
	}
	reused := createA
	reused.Fingerprint = integrationSyncV2Fingerprint("reused")
	if result, err := repositoryA.Commit(ctx, reused); err != nil || result.Kind != syncv2.CommitRejected ||
		result.Reason != syncv2.ReasonIdempotencyKeyReuse {
		t.Fatalf("idempotency key reuse = %#v, %v", result, err)
	}
	if result, err := repositoryB.Commit(ctx, createA); err != nil || result.Kind != syncv2.CommitApplied {
		t.Fatalf("same identifiers in other vault = %#v, %v", result, err)
	}
	if receipt, err := repositoryB.FindReceipt(ctx, createA.MutationID); err != nil || receipt == nil {
		t.Fatalf("other vault receipt = %#v, %v", receipt, err)
	}

	revision1 := syncv2.Revision(1)
	update := syncv2.CommitCommand{
		Kind: syncv2.CommandCardUpsert, MutationID: integrationSyncV2MutationID(t, 102),
		Fingerprint: integrationSyncV2Fingerprint("update"), CommittedAt: 1_300,
		CardID: cardA, ExpectedRevision: &revision1, NextRevision: 2, OccurredAt: 1_300,
	}
	assertSyncV2Applied(t, ctx, repositoryA, update)
	conflictCommand := syncv2.CommitCommand{
		Kind: syncv2.CommandConflictUpsert, MutationID: integrationSyncV2MutationID(t, 103),
		Fingerprint: integrationSyncV2Fingerprint("conflict"), CommittedAt: 1_400,
		CardID: cardA, ConflictID: conflict, ServerRevision: 2, OccurredAt: 1_400,
	}
	assertSyncV2Applied(t, ctx, repositoryA, conflictCommand)
	revision2 := syncv2.Revision(2)
	resolve := syncv2.CommitCommand{
		Kind: syncv2.CommandResolveConflicts, MutationID: integrationSyncV2MutationID(t, 104),
		Fingerprint: integrationSyncV2Fingerprint("resolve"), CommittedAt: 1_500,
		CardID: cardA, ExpectedRevision: &revision2, NextRevision: 3, OccurredAt: 1_500,
		ConflictIDs: []syncv2.ConflictID{conflict},
	}
	assertSyncV2Applied(t, ctx, repositoryA, resolve)
	assertSyncV2Applied(t, ctx, repositoryA, integrationSyncV2Create(t, 105, cardB, 1_550))
	if card, err := repositoryA.FindCard(ctx, cardB); err != nil || card == nil || card.OfficialDisplayID != 2 {
		t.Fatalf("second display ID = %#v, %v", card, err)
	}
	revision3 := syncv2.Revision(3)
	deleteCommand := syncv2.CommitCommand{
		Kind: syncv2.CommandCardDelete, MutationID: integrationSyncV2MutationID(t, 106),
		Fingerprint: integrationSyncV2Fingerprint("delete"), CommittedAt: 1_600,
		CardID: cardA, ExpectedRevision: &revision3, NextRevision: 4, OccurredAt: 1_600,
	}
	assertSyncV2Applied(t, ctx, repositoryA, deleteCommand)
	if card, err := repositoryA.FindCard(ctx, cardA); err != nil || card != nil {
		t.Fatalf("deleted card = %#v, %v", card, err)
	}
	if receipt, err := repositoryA.FindReceipt(ctx, deleteCommand.MutationID); err != nil ||
		receipt == nil || receipt.AppliedRevision != 4 {
		t.Fatalf("delete receipt = %#v, %v", receipt, err)
	}

	first, err := repositoryA.ReadPage(ctx, 0, nil, 2)
	if err != nil || first.HighWatermark != 7 || first.Kind != syncv2.PageMore ||
		len(first.Changes) != 2 || first.Changes[0].Sequence != 1 || first.Changes[1].Sequence != 2 {
		t.Fatalf("first page = %#v, %v", first, err)
	}
	watermark := first.HighWatermark
	after := first.AfterSequence
	kinds := []syncv2.ChangeKind{first.Changes[0].Kind, first.Changes[1].Kind}
	for {
		page, pageErr := repositoryA.ReadPage(ctx, after, &watermark, 2)
		if pageErr != nil {
			t.Fatal(pageErr)
		}
		for _, change := range page.Changes {
			kinds = append(kinds, change.Kind)
		}
		after = page.AfterSequence
		if page.Kind == syncv2.PageComplete {
			break
		}
	}
	wantKinds := []syncv2.ChangeKind{
		syncv2.ChangeCardUpsert, syncv2.ChangeCardUpsert, syncv2.ChangeConflictUpsert,
		syncv2.ChangeCardUpsert, syncv2.ChangeConflictTombstone,
		syncv2.ChangeCardUpsert, syncv2.ChangeCardTombstone,
	}
	if fmt.Sprint(kinds) != fmt.Sprint(wantKinds) {
		t.Fatalf("journal kinds = %v, want %v", kinds, wantKinds)
	}
}

func TestSyncV2JournalConcurrentCASAndAtomicRollbackPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultContext := seedEntitlementOwner(t, ctx, pool, 173, 273, 373)
	repository := openSyncV2Journal(t, ctx, syncV2Directory(t, pool), vaultContext)
	cardID := integrationSyncV2CardID(t, 11)
	assertSyncV2Applied(t, ctx, repository, integrationSyncV2Create(t, 111, cardID, 1_000))

	revision1 := syncv2.Revision(1)
	commands := []syncv2.CommitCommand{
		{
			Kind: syncv2.CommandCardUpsert, MutationID: integrationSyncV2MutationID(t, 112),
			Fingerprint: integrationSyncV2Fingerprint("concurrent-a"), CommittedAt: 1_100,
			CardID: cardID, ExpectedRevision: &revision1, NextRevision: 2, OccurredAt: 1_100,
		},
		{
			Kind: syncv2.CommandCardUpsert, MutationID: integrationSyncV2MutationID(t, 113),
			Fingerprint: integrationSyncV2Fingerprint("concurrent-b"), CommittedAt: 1_101,
			CardID: cardID, ExpectedRevision: &revision1, NextRevision: 2, OccurredAt: 1_101,
		},
	}
	results := make([]syncv2.CommitResult, len(commands))
	errorsByIndex := make([]error, len(commands))
	var wait sync.WaitGroup
	for index := range commands {
		wait.Add(1)
		go func(index int) {
			defer wait.Done()
			results[index], errorsByIndex[index] = repository.Commit(ctx, commands[index])
		}(index)
	}
	wait.Wait()
	applied, stale := 0, 0
	for index, result := range results {
		if errorsByIndex[index] != nil {
			t.Fatalf("concurrent commit %d: %v", index, errorsByIndex[index])
		}
		switch {
		case result.Kind == syncv2.CommitApplied:
			applied++
		case result.Kind == syncv2.CommitRejected && result.Reason == syncv2.ReasonStaleRevision:
			stale++
		default:
			t.Fatalf("unexpected concurrent result %d: %#v", index, result)
		}
	}
	if applied != 1 || stale != 1 {
		t.Fatalf("concurrent outcomes applied=%d stale=%d", applied, stale)
	}

	rollbackContext := seedEntitlementOwner(t, ctx, pool, 174, 274, 374)
	rollbackRepository := openSyncV2Journal(t, ctx, syncV2Directory(t, pool), rollbackContext)
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_sync_v2_change() RETURNS trigger
		LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected journal failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER fail_sync_v2_change BEFORE INSERT ON vault_sync_v2_changes
		FOR EACH ROW EXECUTE FUNCTION fail_sync_v2_change()`); err != nil {
		t.Fatal(err)
	}
	rollbackCard := integrationSyncV2CardID(t, 12)
	rollbackCommand := integrationSyncV2Create(t, 114, rollbackCard, 1_200)
	if _, err := rollbackRepository.Commit(ctx, rollbackCommand); err == nil {
		t.Fatal("expected injected journal error")
	}
	if card, err := rollbackRepository.FindCard(ctx, rollbackCard); err != nil || card != nil {
		t.Fatalf("card survived failed journal insert: %#v, %v", card, err)
	}
	if receipt, err := rollbackRepository.FindReceipt(ctx, rollbackCommand.MutationID); err != nil || receipt != nil {
		t.Fatalf("receipt survived failed journal insert: %#v, %v", receipt, err)
	}
	page, err := rollbackRepository.ReadPage(ctx, 0, nil, 10)
	if err != nil || page.HighWatermark != 0 || len(page.Changes) != 0 || page.Kind != syncv2.PageComplete {
		t.Fatalf("page after rollback = %#v, %v", page, err)
	}
	if _, err := pool.Exec(ctx, "DROP TRIGGER fail_sync_v2_change ON vault_sync_v2_changes"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DROP FUNCTION fail_sync_v2_change()"); err != nil {
		t.Fatal(err)
	}
	assertSyncV2Applied(t, ctx, rollbackRepository, rollbackCommand)
}

func TestSyncV2JournalFiveHundredPageFixedWatermarkAndMalformedRowsPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultContext := seedEntitlementOwner(t, ctx, pool, 175, 275, 375)
	repository := openSyncV2Journal(t, ctx, syncV2Directory(t, pool), vaultContext)
	cardID := integrationSyncV2CardID(t, 21)
	if _, err := pool.Exec(ctx, `INSERT INTO vault_sync_v2_changes(
		account_id, vault_id, sequence, change_kind, card_id, conflict_id,
		revision, official_display_id, occurred_at
	) SELECT $1, $2, sequence, 'card-upsert', $3, NULL, 1, 1, 1000 + sequence
	FROM generate_series(1, 501) AS sequence`, string(vaultContext.AccountID), string(vaultContext.VaultID), string(cardID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE vault_sync_v2_states SET next_change_sequence = 502
		WHERE account_id = $1 AND vault_id = $2`, string(vaultContext.AccountID), string(vaultContext.VaultID)); err != nil {
		t.Fatal(err)
	}
	first, err := repository.ReadPage(ctx, 0, nil, syncv2.MaximumPageSize)
	if err != nil || first.HighWatermark != 501 || first.Kind != syncv2.PageMore ||
		len(first.Changes) != 500 || first.AfterSequence != 500 {
		t.Fatalf("500-item page = %#v, %v", first, err)
	}
	watermark := first.HighWatermark
	finalPage, err := repository.ReadPage(ctx, first.AfterSequence, &watermark, syncv2.MaximumPageSize)
	if err != nil || finalPage.Kind != syncv2.PageComplete || len(finalPage.Changes) != 1 ||
		finalPage.Changes[0].Sequence != 501 {
		t.Fatalf("final fixed-watermark page = %#v, %v", finalPage, err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_sync_v2_changes(
		account_id, vault_id, sequence, change_kind, card_id, conflict_id,
		revision, official_display_id, occurred_at
	) VALUES ($1, $2, 502, 'card-upsert', $3, NULL, 1, 1, 2000)`,
		string(vaultContext.AccountID), string(vaultContext.VaultID), string(cardID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE vault_sync_v2_states SET next_change_sequence = 503
		WHERE account_id = $1 AND vault_id = $2`, string(vaultContext.AccountID), string(vaultContext.VaultID)); err != nil {
		t.Fatal(err)
	}
	stable, err := repository.ReadPage(ctx, 501, &watermark, 10)
	if err != nil || stable.Kind != syncv2.PageComplete || len(stable.Changes) != 0 || stable.HighWatermark != 501 {
		t.Fatalf("new edit leaked into fixed snapshot: %#v, %v", stable, err)
	}

	if _, err := pool.Exec(ctx, "ALTER TABLE vault_sync_v2_changes DROP CONSTRAINT vault_sync_v2_changes_shape_check"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE vault_sync_v2_changes SET change_kind = 'malformed' WHERE account_id = $1 AND vault_id = $2 AND sequence = 1`,
		string(vaultContext.AccountID), string(vaultContext.VaultID)); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.ReadPage(ctx, 0, nil, 10); !errors.Is(err, postgresadapter.ErrSyncV2PageGap) {
		t.Fatalf("malformed change error = %v", err)
	}

	mutationID := integrationSyncV2MutationID(t, 121)
	if _, err := pool.Exec(ctx, `INSERT INTO vault_sync_v2_commits(
		account_id, vault_id, mutation_id, fingerprint, card_id, applied_revision, committed_at
	) VALUES ($1, $2, $3, $4, $5, 1, 1000)`, string(vaultContext.AccountID),
		string(vaultContext.VaultID), string(mutationID), string(integrationSyncV2Fingerprint("malformed-receipt")),
		string(cardID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "ALTER TABLE vault_sync_v2_commits DROP CONSTRAINT vault_sync_v2_commits_shape_check"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `UPDATE vault_sync_v2_commits SET fingerprint = 'invalid'
		WHERE account_id = $1 AND vault_id = $2 AND mutation_id = $3`, string(vaultContext.AccountID),
		string(vaultContext.VaultID), string(mutationID)); err != nil {
		t.Fatal(err)
	}
	if _, err := repository.FindReceipt(ctx, mutationID); !errors.Is(err, postgresadapter.ErrInvalidSyncV2Record) {
		t.Fatalf("malformed receipt error = %v", err)
	}
}

func syncV2Directory(t *testing.T, pool *pgxpool.Pool) *postgresadapter.SyncV2JournalDirectory {
	t.Helper()
	directory, err := postgresadapter.NewSyncV2JournalDirectory(pool)
	if err != nil {
		t.Fatal(err)
	}
	return directory
}

func openSyncV2Journal(
	t *testing.T,
	ctx context.Context,
	directory *postgresadapter.SyncV2JournalDirectory,
	vaultContext identity.VaultContext,
) syncv2.Repository {
	t.Helper()
	opened, err := directory.Open(ctx, vaultContext)
	if err != nil || opened.Kind != syncv2.JournalOpened || opened.Repository == nil {
		t.Fatalf("open Sync v2 journal = %#v, %v", opened, err)
	}
	return opened.Repository
}

func integrationSyncV2CardID(t *testing.T, suffix int) syncv2.CardID {
	t.Helper()
	value, err := syncv2.ParseCardID(integrationUUID(t, 20_000+suffix))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func integrationSyncV2ConflictID(t *testing.T, suffix int) syncv2.ConflictID {
	t.Helper()
	value, err := syncv2.ParseConflictID(integrationUUID(t, 30_000+suffix))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func integrationSyncV2MutationID(t *testing.T, suffix int) syncv2.MutationID {
	t.Helper()
	value, err := syncv2.ParseMutationID(integrationUUID(t, 40_000+suffix))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func integrationSyncV2Fingerprint(seed string) syncv2.Fingerprint {
	digest := sha256.Sum256([]byte(seed))
	value, err := syncv2.ParseFingerprint(base64.RawURLEncoding.EncodeToString(digest[:]))
	if err != nil {
		panic(err)
	}
	return value
}

func integrationSyncV2Create(t *testing.T, mutationSuffix int, cardID syncv2.CardID, occurredAt int64) syncv2.CommitCommand {
	t.Helper()
	return syncv2.CommitCommand{
		Kind: syncv2.CommandCardUpsert, MutationID: integrationSyncV2MutationID(t, mutationSuffix),
		Fingerprint: integrationSyncV2Fingerprint(fmt.Sprintf("create-%d", mutationSuffix)),
		CommittedAt: occurredAt + 10, CardID: cardID, NextRevision: 1, OccurredAt: occurredAt,
	}
}

func assertSyncV2Applied(t *testing.T, ctx context.Context, repository syncv2.Repository, command syncv2.CommitCommand) {
	t.Helper()
	result, err := repository.Commit(ctx, command)
	if err != nil || result.Kind != syncv2.CommitApplied || result.Receipt == nil {
		t.Fatalf("commit %#v = %#v, %v", command, result, err)
	}
}
