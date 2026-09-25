//go:build integration

package integration_test

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/vaultdata"
	"github.com/fukamu/notes/backend/migrations"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestVaultDataPurgePostgres(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required for integration tests")
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("unsafe test database target: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 12)
	if err != nil {
		t.Fatalf("OpenPool() error = %v", err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, "DROP SCHEMA public CASCADE"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "CREATE SCHEMA public"); err != nil {
		t.Fatal(err)
	}
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrator.Up(ctx); err != nil {
		t.Fatalf("migrate purge database: %v", err)
	}

	scopeA := accountDeletionScopeForSuffix(t, 31)
	scopeB := accountDeletionScopeForSuffix(t, 32)
	seedVaultPurgeOwner(t, ctx, pool, scopeA)
	seedVaultPurgeOwner(t, ctx, pool, scopeB)
	keyA := "obj_v1_" + strings.Repeat("A", 43)
	intentKeyA := "obj_v1_" + strings.Repeat("B", 43)
	keyB := "obj_v1_" + strings.Repeat("C", 43)
	seedVaultPurgeLiveData(t, ctx, pool, scopeA, keyA, intentKeyA, 31)
	seedOtherVaultLiveData(t, ctx, pool, scopeB, keyB, 32)
	seedPreservedAccountData(t, ctx, pool, scopeA, 31)

	// A conflicting outbox owner must stop before any source row is removed.
	if _, err := pool.Exec(ctx, `INSERT INTO vault_object_delete_outbox(
		vault_id, object_key, attempt_count, next_attempt_at, created_at
	) VALUES ($1, $2, 0, 900, 900)`, string(scopeB.VaultID), keyA); err != nil {
		t.Fatalf("seed cross-Vault outbox collision: %v", err)
	}
	operationA := startVaultPurgeDeletion(t, ctx, pool, scopeA, 2_931, 'A', 'B')
	store, err := postgresadapter.NewVaultDataPurgeStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	command := vaultdata.PurgeCommand{
		Scope:       vaultdata.Scope{AccountID: scopeA.AccountID, VaultID: scopeA.VaultID},
		OperationID: vaultDataOperationID(t, operationA), RequestedAt: 1_500,
	}
	unauthorized := command
	unauthorized.OperationID, err = vaultdata.ParseOperationID(integrationUUID(t, 9_999))
	if err != nil {
		t.Fatal(err)
	}
	unauthorizedResult, err := store.PurgeVaultData(ctx, unauthorized)
	if err != nil || unauthorizedResult.Kind != vaultdata.RepositoryIntegrityFailure {
		t.Fatalf("unauthorized purge = %#v, %v", unauthorizedResult, err)
	}
	collision, err := store.PurgeVaultData(ctx, command)
	if err != nil || collision.Kind != vaultdata.RepositoryIntegrityFailure {
		t.Fatalf("collision purge = %#v, %v", collision, err)
	}
	assertRowCount(t, ctx, pool, "vault_encrypted_objects", "vault_id", string(scopeA.VaultID), 1)
	assertRowCount(t, ctx, pool, "vault_encrypted_write_intents", "vault_id", string(scopeA.VaultID), 1)
	if _, err := pool.Exec(ctx, "DELETE FROM vault_object_delete_outbox WHERE object_key = $1", keyA); err != nil {
		t.Fatal(err)
	}

	result, err := store.PurgeVaultData(ctx, command)
	if err != nil || result.Kind != vaultdata.RepositoryPurged || result.EnqueuedObjectKeys != 2 || result.LiveRowsBefore != 9 {
		t.Fatalf("PurgeVaultData() = %#v, %v", result, err)
	}
	assertPurgedVaultData(t, ctx, pool, scopeA, keyA, intentKeyA)
	assertPreservedAccountData(t, ctx, pool, scopeA)
	assertOtherVaultData(t, ctx, pool, scopeB, keyB)

	mismatchedTime := command
	mismatchedTime.RequestedAt = 9_000
	mismatchedResult, err := store.PurgeVaultData(ctx, mismatchedTime)
	if err != nil || mismatchedResult.Kind != vaultdata.RepositoryIntegrityFailure {
		t.Fatalf("mismatched receipt time purge = %#v, %v", mismatchedResult, err)
	}
	replayed, err := store.PurgeVaultData(ctx, command)
	if err != nil || replayed.Kind != vaultdata.RepositoryAlreadyPurged {
		t.Fatalf("replayed purge = %#v, %v", replayed, err)
	}
	var stableCreatedAt int64
	if err := pool.QueryRow(ctx,
		"SELECT created_at FROM vault_object_delete_outbox WHERE object_key = $1", keyA,
	).Scan(&stableCreatedAt); err != nil || stableCreatedAt != 1_500 {
		t.Fatalf("stable outbox time = %d, %v", stableCreatedAt, err)
	}

	wrongOwner := command
	wrongOwner.Scope.AccountID = scopeB.AccountID
	mismatch, err := store.PurgeVaultData(ctx, wrongOwner)
	if err != nil || mismatch.Kind != vaultdata.RepositoryOwnerMismatch {
		t.Fatalf("owner mismatch = %#v, %v", mismatch, err)
	}
	assertDeletionWriteGate(t, ctx, pool, scopeA)
	assertWriteFirstRaceIsPurged(t, ctx, pool, scopeB)
	assertPurgeRollsBackOnFailure(t, ctx, pool, store)

	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("database connections still acquired: %d", acquired)
	}
}

func seedVaultPurgeOwner(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, "INSERT INTO accounts(account_id, created_at) VALUES ($1, 1000)", string(scope.AccountID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO personal_vaults(vault_id, account_id, created_at)
		VALUES ($1, $2, 1000)`, string(scope.VaultID), string(scope.AccountID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_dek_versions(
		vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
	) VALUES ($1, 1, 'kms://test/key', 'QUFB', true, 1000)`, string(scope.VaultID)); err != nil {
		t.Fatal(err)
	}
}

func seedVaultPurgeLiveData(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	objectKey, intentKey string,
	suffix int,
) {
	t.Helper()
	cardID := integrationUUID(t, 4_000+suffix)
	if _, err := pool.Exec(ctx, `INSERT INTO vault_encrypted_objects(
		vault_id, object_type, object_id, object_revision, write_id, object_key,
		plaintext_bytes, ciphertext_bytes, crypto_version, dek_version, created_at
	) VALUES ($1, 'card', $2, 1, $3, $4, 10, 20,
		'fukamu-envelope-aes-256-gcm/v1', 1, 1100)`,
		string(scope.VaultID), cardID, integrationUUID(t, 4_100+suffix), objectKey); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_encrypted_write_intents(
		vault_id, write_id, object_type, object_id, expected_revision, object_revision,
		object_key, plaintext_bytes, crypto_version, dek_version, created_at
	) VALUES ($1, $2, 'conflict', $3, NULL, 1, $4, 12,
		'fukamu-envelope-aes-256-gcm/v1', 1, 1150)`,
		string(scope.VaultID), integrationUUID(t, 4_200+suffix), integrationUUID(t, 4_300+suffix), intentKey); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_sync_v2_states(
		account_id, vault_id, next_display_id, next_change_sequence
	) VALUES ($1, $2, 2, 2)`, string(scope.AccountID), string(scope.VaultID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_sync_v2_cards(
		account_id, vault_id, card_id, official_display_id, revision, updated_at
	) VALUES ($1, $2, $3, 1, 1, 1200)`, string(scope.AccountID), string(scope.VaultID), cardID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_sync_v2_commits(
		account_id, vault_id, mutation_id, fingerprint, card_id, applied_revision, committed_at
	) VALUES ($1, $2, $3, $4, $5, 1, 1200)`, string(scope.AccountID), string(scope.VaultID),
		integrationUUID(t, 4_400+suffix), strings.Repeat("A", 43), cardID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_sync_v2_changes(
		account_id, vault_id, sequence, change_kind, card_id, conflict_id,
		revision, official_display_id, occurred_at
	) VALUES ($1, $2, 1, 'card-upsert', $3, NULL, 1, 1, 1200)`,
		string(scope.AccountID), string(scope.VaultID), cardID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_quota_usage(
		account_id, vault_id, revision, active_cards, plaintext_bytes,
		last_transition_reservation_id, created_at, updated_at
	) VALUES ($1, $2, 1, 1, 10, NULL, 1000, 1200)`, string(scope.AccountID), string(scope.VaultID)); err != nil {
		t.Fatal(err)
	}
	reservationID := integrationUUID(t, 4_500+suffix)
	if _, err := pool.Exec(ctx, `INSERT INTO vault_quota_reservations(
		account_id, vault_id, reservation_id, fingerprint, card_id, change_kind,
		card_delta, plaintext_byte_delta, charged_card_delta, charged_plaintext_byte_delta,
		usage_revision_at_reservation, state, created_at, reconcile_after,
		finalized_at, finalized_usage_revision
	) VALUES ($1, $2, $3, $4, $5, 'create', 1, 10, 1, 10,
		1, 'reserved', 1200, 1300, NULL, NULL)`, string(scope.AccountID), string(scope.VaultID),
		reservationID, strings.Repeat("B", 42)+"A", cardID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_quota_finalization_assertions(
		account_id, vault_id, reservation_id, assertion_passed
	) VALUES ($1, $2, $3, 1)`, string(scope.AccountID), string(scope.VaultID), reservationID); err != nil {
		t.Fatal(err)
	}
}

func seedOtherVaultLiveData(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	objectKey string,
	suffix int,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, `INSERT INTO vault_encrypted_objects(
		vault_id, object_type, object_id, object_revision, write_id, object_key,
		plaintext_bytes, ciphertext_bytes, crypto_version, dek_version, created_at
	) VALUES ($1, 'card', $2, 1, $3, $4, 10, 20,
		'fukamu-envelope-aes-256-gcm/v1', 1, 1100)`, string(scope.VaultID),
		integrationUUID(t, 5_000+suffix), integrationUUID(t, 5_100+suffix), objectKey); err != nil {
		t.Fatal(err)
	}
}

func seedPreservedAccountData(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	suffix int,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, `INSERT INTO identities(
		identity_id, account_id, provider, issuer, subject, created_at
	) VALUES ($1, $2, 'google-oidc', 'https://issuer.test', $3, 1000)`,
		integrationUUID(t, 6_000+suffix), string(scope.AccountID), "owner-"+integrationUUID(t, suffix)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO billing_subscriptions(
		subscription_id, account_id, vault_id, provider, version, status,
		payment_method_ready, cancelled_at, created_at, updated_at
	) VALUES ($1, $2, $3, 'stripe', 1, 'cancelled', false, 1400, 1000, 1400)`,
		integrationUUID(t, 6_100+suffix), string(scope.AccountID), string(scope.VaultID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO terms_consent_evidence(
		account_id, vault_id, consent_id, submission_id, terms_version, terms_hash,
		serialized_terms, consent, accepted_at
	) VALUES ($1, $2, $3, $4, 'terms-v1:2026-01-01', $5, '{}', 'affirmed', 1000)`,
		string(scope.AccountID), string(scope.VaultID), integrationUUID(t, 6_200+suffix),
		integrationUUID(t, 6_300+suffix), "sha256:"+strings.Repeat("a", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO contract_evidence(
		account_id, vault_id, evidence_id, submission_id, offer_hash, offer_version,
		disclosure_version, serialized_offer, consent, confirmed_at
	) VALUES ($1, $2, $3, $4, $5, 'legal-commerce-v1:2026-01-01',
		'2026-01-01', '{}', 'affirmed', 1000)`, string(scope.AccountID), string(scope.VaultID),
		integrationUUID(t, 6_400+suffix), integrationUUID(t, 6_500+suffix),
		"sha256:"+strings.Repeat("b", 64)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO privacy_requests(
		account_id, vault_id, request_id, submission_id, request_kind, revision,
		state, requested_at, updated_at
	) VALUES ($1, $2, $3, $4, 'deletion', 1, 'verification-pending', 1000, 1000)`,
		string(scope.AccountID), string(scope.VaultID), integrationUUID(t, 6_600+suffix),
		integrationUUID(t, 6_700+suffix)); err != nil {
		t.Fatal(err)
	}
}

func startVaultPurgeDeletion(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	operationSuffix int,
	idempotencyCharacter, secretCharacter byte,
) accountdeletion.Operation {
	t.Helper()
	store, err := postgresadapter.NewAccountDeletionStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	operation := accountDeletionOperation(t, scope, operationSuffix, 1_300)
	continuation := accountDeletionContinuation(t, operation, idempotencyCharacter, secretCharacter, 10_000)
	result, err := store.Start(ctx, operation, continuation)
	if err != nil || result.Kind != accountdeletion.StartCreated {
		t.Fatalf("start account deletion = %#v, %v", result, err)
	}
	markVaultDataPurgeRunning(t, ctx, pool, operation)
	return operation
}

func markVaultDataPurgeRunning(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	operation accountdeletion.Operation,
) {
	t.Helper()
	tag, err := pool.Exec(ctx, `UPDATE account_deletion_operations SET
		revision = 2, state = 'running', current_step = 'delete-vault-data',
		attempt = 1, not_before = NULL, lease_expires_at = 3000,
		failure_code = NULL, updated_at = 1500, completed_at = NULL
		WHERE operation_id = $1 AND account_id = $2 AND vault_id = $3`,
		string(operation.OperationID), string(operation.Scope.AccountID), string(operation.Scope.VaultID))
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("mark Vault purge running: rows=%d err=%v", tag.RowsAffected(), err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_deletion_step_receipts(
		operation_id, step, completed_at
	) VALUES ($1, 'revoke-sessions', 1400), ($1, 'cancel-subscription', 1500)`,
		string(operation.OperationID)); err != nil {
		t.Fatalf("seed Vault purge receipts: %v", err)
	}
}

func vaultDataOperationID(t *testing.T, operation accountdeletion.Operation) vaultdata.OperationID {
	t.Helper()
	operationID, err := vaultdata.ParseOperationID(string(operation.OperationID))
	if err != nil {
		t.Fatal(err)
	}
	return operationID
}

func assertPurgedVaultData(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	objectKeys ...string,
) {
	t.Helper()
	tables := []string{
		"vault_encrypted_objects", "vault_encrypted_write_intents", "vault_sync_v2_states",
		"vault_sync_v2_cards", "vault_sync_v2_conflicts", "vault_sync_v2_commits",
		"vault_sync_v2_changes", "vault_quota_usage", "vault_quota_reservations",
		"vault_quota_finalization_assertions",
	}
	for _, table := range tables {
		assertRowCount(t, ctx, pool, table, "vault_id", string(scope.VaultID), 0)
	}
	for _, objectKey := range objectKeys {
		var vaultID string
		var attemptCount, nextAttemptAt, createdAt int64
		err := pool.QueryRow(ctx, `SELECT vault_id, attempt_count, next_attempt_at, created_at
			FROM vault_object_delete_outbox WHERE object_key = $1`, objectKey,
		).Scan(&vaultID, &attemptCount, &nextAttemptAt, &createdAt)
		if err != nil || vaultID != string(scope.VaultID) || attemptCount != 0 ||
			nextAttemptAt != 1_500 || createdAt != 1_500 {
			t.Fatalf("outbox %q = %q %d %d %d, %v", objectKey, vaultID, attemptCount, nextAttemptAt, createdAt, err)
		}
	}
}

func assertPreservedAccountData(t *testing.T, ctx context.Context, pool *pgxpool.Pool, scope accountdeletion.Scope) {
	t.Helper()
	for _, table := range []string{
		"accounts", "personal_vaults", "identities", "vault_dek_versions",
		"billing_subscriptions", "terms_consent_evidence", "contract_evidence",
		"privacy_requests", "account_deletion_operations",
	} {
		column := "account_id"
		value := string(scope.AccountID)
		if table == "vault_dek_versions" {
			column = "vault_id"
			value = string(scope.VaultID)
		}
		assertRowCount(t, ctx, pool, table, column, value, 1)
	}
}

func assertOtherVaultData(t *testing.T, ctx context.Context, pool *pgxpool.Pool, scope accountdeletion.Scope, objectKey string) {
	t.Helper()
	assertRowCount(t, ctx, pool, "vault_encrypted_objects", "vault_id", string(scope.VaultID), 1)
	var storedKey string
	if err := pool.QueryRow(ctx, "SELECT object_key FROM vault_encrypted_objects WHERE vault_id = $1", string(scope.VaultID)).Scan(&storedKey); err != nil || storedKey != objectKey {
		t.Fatalf("other Vault object = %q, %v", storedKey, err)
	}
}

func assertDeletionWriteGate(t *testing.T, ctx context.Context, pool *pgxpool.Pool, scope accountdeletion.Scope) {
	t.Helper()
	_, err := pool.Exec(ctx, `INSERT INTO vault_sync_v2_states(
		account_id, vault_id, next_display_id, next_change_sequence
	) VALUES ($1, $2, 1, 1)`, string(scope.AccountID), string(scope.VaultID))
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) || postgresError.ConstraintName != "account_deletion_write_gate" {
		t.Fatalf("post-deletion write error = %v", err)
	}
	if _, err := pool.Exec(ctx, `UPDATE vault_object_delete_outbox SET next_attempt_at = next_attempt_at
		WHERE vault_id = $1`, string(scope.VaultID)); err != nil {
		t.Fatalf("outbox drain mutation was gated: %v", err)
	}
}

func assertWriteFirstRaceIsPurged(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `INSERT INTO vault_sync_v2_states(
		account_id, vault_id, next_display_id, next_change_sequence
	) VALUES ($1, $2, 1, 1)`, string(scope.AccountID), string(scope.VaultID)); err != nil {
		t.Fatalf("write-first mutation: %v", err)
	}
	operation := accountDeletionOperation(t, scope, 2_932, 1_300)
	continuation := accountDeletionContinuation(t, operation, 'C', 'D', 10_000)
	done := make(chan error, 1)
	go func() {
		store, createErr := postgresadapter.NewAccountDeletionStore(pool)
		if createErr != nil {
			done <- createErr
			return
		}
		result, startErr := store.Start(ctx, operation, continuation)
		if startErr == nil && result.Kind != accountdeletion.StartCreated {
			startErr = errors.New("deletion start was not created")
		}
		done <- startErr
	}()
	select {
	case err := <-done:
		t.Fatalf("deletion start did not wait for write lock: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatalf("deletion start after write commit: %v", err)
	}
	markVaultDataPurgeRunning(t, ctx, pool, operation)
	store, _ := postgresadapter.NewVaultDataPurgeStore(pool)
	result, err := store.PurgeVaultData(ctx, vaultdata.PurgeCommand{
		Scope:       vaultdata.Scope{AccountID: scope.AccountID, VaultID: scope.VaultID},
		OperationID: vaultDataOperationID(t, operation), RequestedAt: 1_500,
	})
	if err != nil || result.Kind != vaultdata.RepositoryPurged {
		t.Fatalf("write-first purge = %#v, %v", result, err)
	}
	assertRowCount(t, ctx, pool, "vault_sync_v2_states", "vault_id", string(scope.VaultID), 0)
}

func assertPurgeRollsBackOnFailure(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	store *postgresadapter.VaultDataPurgeStore,
) {
	t.Helper()
	scope := accountDeletionScopeForSuffix(t, 33)
	seedVaultPurgeOwner(t, ctx, pool, scope)
	key := "obj_v1_" + strings.Repeat("D", 43)
	seedOtherVaultLiveData(t, ctx, pool, scope, key, 33)
	if _, err := pool.Exec(ctx, `INSERT INTO vault_sync_v2_states(
		account_id, vault_id, next_display_id, next_change_sequence
	) VALUES ($1, $2, 1, 1)`, string(scope.AccountID), string(scope.VaultID)); err != nil {
		t.Fatal(err)
	}
	operation := startVaultPurgeDeletion(t, ctx, pool, scope, 2_933, 'E', 'F')
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_test_vault_purge() RETURNS trigger
		LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''injected purge failure''; END'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER fail_test_vault_purge
		BEFORE DELETE ON vault_sync_v2_states FOR EACH ROW EXECUTE FUNCTION fail_test_vault_purge()`); err != nil {
		t.Fatal(err)
	}
	_, err := store.PurgeVaultData(ctx, vaultdata.PurgeCommand{
		Scope:       vaultdata.Scope{AccountID: scope.AccountID, VaultID: scope.VaultID},
		OperationID: vaultDataOperationID(t, operation), RequestedAt: 1_500,
	})
	if err == nil {
		t.Fatal("injected purge unexpectedly succeeded")
	}
	assertRowCount(t, ctx, pool, "vault_encrypted_objects", "vault_id", string(scope.VaultID), 1)
	assertRowCount(t, ctx, pool, "vault_object_delete_outbox", "vault_id", string(scope.VaultID), 0)
	assertRowCount(t, ctx, pool, "vault_sync_v2_states", "vault_id", string(scope.VaultID), 1)
	if _, err := pool.Exec(ctx, "DROP TRIGGER fail_test_vault_purge ON vault_sync_v2_states"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DROP FUNCTION fail_test_vault_purge()"); err != nil {
		t.Fatal(err)
	}
}

func assertRowCount(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	table, column, value string,
	want int64,
) {
	t.Helper()
	allowed := map[string]map[string]bool{
		"accounts": {"account_id": true}, "personal_vaults": {"account_id": true},
		"identities": {"account_id": true}, "vault_dek_versions": {"vault_id": true},
		"billing_subscriptions": {"account_id": true}, "terms_consent_evidence": {"account_id": true},
		"contract_evidence": {"account_id": true}, "privacy_requests": {"account_id": true},
		"entitlement_projections":     {"vault_id": true},
		"account_deletion_operations": {"account_id": true}, "vault_encrypted_objects": {"vault_id": true},
		"vault_encrypted_write_intents": {"vault_id": true}, "vault_object_delete_outbox": {"vault_id": true},
		"vault_sync_v2_states": {"vault_id": true}, "vault_sync_v2_cards": {"vault_id": true},
		"vault_sync_v2_conflicts": {"vault_id": true}, "vault_sync_v2_commits": {"vault_id": true},
		"vault_sync_v2_changes": {"vault_id": true}, "vault_quota_usage": {"vault_id": true},
		"vault_quota_reservations": {"vault_id": true}, "vault_quota_finalization_assertions": {"vault_id": true},
	}
	if !allowed[table][column] {
		t.Fatalf("unsafe row-count target %s.%s", table, column)
	}
	var count int64
	query := "SELECT COUNT(*) FROM " + table + " WHERE " + column + " = $1" // #nosec G202 -- identifiers are allowlisted above.
	if err := pool.QueryRow(ctx, query, value).Scan(&count); err != nil || count != want {
		t.Fatalf("%s.%s count = %d, %v; want %d", table, column, count, err, want)
	}
}
