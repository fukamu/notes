//go:build integration

package integration_test

import (
	"context"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestVaultPrivateObjectPurgePostgresAndMemoryStorage(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	scopeA := accountDeletionScopeForSuffix(t, 41)
	scopeB := accountDeletionScopeForSuffix(t, 42)
	seedVaultPurgeOwner(t, ctx, pool, scopeA)
	seedVaultPurgeOwner(t, ctx, pool, scopeB)
	seedPreservedAccountData(t, ctx, pool, scopeA, 41)
	seedPreservedEntitlement(t, ctx, pool, scopeA, 41)
	operation := startVaultPurgeDeletion(t, ctx, pool, scopeA, 3_041, 'G', 'H')
	markPrivateObjectPurgeRunning(t, ctx, pool, operation, 1_600)

	keyA := privateObjectPurgeKey(t, 'A')
	keyB := privateObjectPurgeKey(t, 'B')
	keyOther := privateObjectPurgeKey(t, 'C')
	seedPrivateObjectOutbox(t, ctx, pool, scopeA, 1_600, keyA, keyB)
	seedPrivateObjectOutbox(t, ctx, pool, scopeB, 1_600, keyOther)
	objectsA, err := objectstorage.NewMemory([]objectstorage.Seed{{
		ObjectKey: keyA, Bytes: []byte{1}, CreatedAtMilli: 1_600,
	}})
	if err != nil {
		t.Fatal(err)
	}
	objectsB, err := objectstorage.NewMemory([]objectstorage.Seed{{
		ObjectKey: keyOther, Bytes: []byte{2}, CreatedAtMilli: 1_600,
	}})
	if err != nil {
		t.Fatal(err)
	}
	directory, err := postgresadapter.NewVaultObjectDeleteOutboxDirectory(pool)
	if err != nil {
		t.Fatal(err)
	}
	command := privateObjectPurgeCommandForOperation(t, operation, 1_600, 2_000)
	service, err := encryptedobject.NewVaultPrivateObjectPurgeService(
		command.Scope, directory, objectsA,
		encryptedobject.VaultPrivateObjectPurgePolicy{BatchLimit: 1, RetryDelayMilli: 100},
	)
	if err != nil {
		t.Fatal(err)
	}

	wrongOperation := command
	wrongOperation.OperationID, err = encryptedobject.ParsePurgeOperationID(integrationUUID(t, 9_941))
	if err != nil {
		t.Fatal(err)
	}
	assertPrivateObjectPurgeResult(t, service, ctx, wrongOperation,
		encryptedobject.VaultPrivateObjectPurgeTerminalFailure,
		encryptedobject.VaultPrivateObjectPurgeIntegrityFailure)
	wrongReceipt := command
	wrongReceipt.PreviousReceiptAt++
	assertPrivateObjectPurgeResult(t, service, ctx, wrongReceipt,
		encryptedobject.VaultPrivateObjectPurgeTerminalFailure,
		encryptedobject.VaultPrivateObjectPurgeIntegrityFailure)
	if objectsA.Calls().Delete != 0 {
		t.Fatal("unauthorized purge called private-object storage")
	}

	crossScope := command
	crossScope.Scope = encryptedobject.VaultPrivateObjectPurgeScope{
		AccountID: scopeB.AccountID, VaultID: scopeB.VaultID,
	}
	assertPrivateObjectPurgeResult(t, service, ctx, crossScope,
		encryptedobject.VaultPrivateObjectPurgeTerminalFailure,
		encryptedobject.VaultPrivateObjectPurgeOwnerMismatch)
	wrongOwner := command
	wrongOwner.Scope.VaultID = scopeB.VaultID
	opened, err := directory.Open(ctx, wrongOwner)
	if err != nil || opened.Kind != encryptedobject.DeleteOutboxOwnerMismatch {
		t.Fatalf("wrong owner Open() = %#v, %v", opened, err)
	}

	assertPrivateObjectPurgeResult(t, service, ctx, command,
		encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
		encryptedobject.VaultPrivateObjectPurgeObjectsRemaining)
	assertOutboxCount(t, ctx, pool, scopeA, 1)
	assertPrivateObjectPurgeResult(t, service, ctx, command,
		encryptedobject.VaultPrivateObjectPurgeConfirmed, "")
	assertOutboxCount(t, ctx, pool, scopeA, 0)
	if objectsA.Calls().Delete != 2 {
		t.Fatalf("bounded delete calls = %d", objectsA.Calls().Delete)
	}
	assertPrivateObjectPurgeResult(t, service, ctx, command,
		encryptedobject.VaultPrivateObjectPurgeConfirmed, "")
	if objectsA.Calls().Delete != 2 {
		t.Fatal("empty replay called private-object storage")
	}
	assertOtherPrivateObjectState(t, ctx, pool, objectsB, scopeB, keyOther)
	assertPreservedAccountData(t, ctx, pool, scopeA)
	assertRowCount(t, ctx, pool, "entitlement_projections", "vault_id", string(scopeA.VaultID), 1)

	service = privateObjectPurgeService(t, command.Scope, directory, objectsA, 3, 100)
	keyD := privateObjectPurgeKey(t, 'D')
	keyE := privateObjectPurgeKey(t, 'E')
	keyF := privateObjectPurgeKey(t, 'F')
	seedPrivateObjectOutbox(t, ctx, pool, scopeA, 3_000, keyD, keyE, keyF)
	putPrivateObjects(t, ctx, objectsA, 3_000, keyD, keyE, keyF)
	objectsA.FailDeleteForTest(keyE)
	command.AttemptedAt = 3_000
	assertPrivateObjectPurgeResult(t, service, ctx, command,
		encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
		encryptedobject.VaultPrivateObjectPurgeStorageUnavailable)
	assertOutboxRetry(t, ctx, pool, scopeA, keyE, 1, 3_100)
	assertOutboxCount(t, ctx, pool, scopeA, 1)
	deleteCalls := objectsA.Calls().Delete
	command.AttemptedAt = 3_099
	assertPrivateObjectPurgeResult(t, service, ctx, command,
		encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
		encryptedobject.VaultPrivateObjectPurgeObjectsRemaining)
	if objectsA.Calls().Delete != deleteCalls {
		t.Fatal("backoff purge called private-object storage")
	}
	command.AttemptedAt = 3_100
	assertPrivateObjectPurgeResult(t, service, ctx, command,
		encryptedobject.VaultPrivateObjectPurgeConfirmed, "")

	keyG := privateObjectPurgeKey(t, 'G')
	seedPrivateObjectOutbox(t, ctx, pool, scopeA, 4_000, keyG)
	putPrivateObjects(t, ctx, objectsA, 4_000, keyG)
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_test_private_object_confirmation() RETURNS trigger
		LANGUAGE plpgsql AS 'BEGIN RAISE EXCEPTION ''injected confirmation failure''; END'`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER fail_test_private_object_confirmation
		BEFORE DELETE ON vault_object_delete_outbox FOR EACH ROW
		EXECUTE FUNCTION fail_test_private_object_confirmation()`); err != nil {
		t.Fatal(err)
	}
	command.AttemptedAt = 4_000
	assertPrivateObjectPurgeResult(t, service, ctx, command,
		encryptedobject.VaultPrivateObjectPurgeRetryableFailure,
		encryptedobject.VaultPrivateObjectPurgeDeleteConfirmationUnavailable)
	if _, found, err := objectsA.Get(ctx, keyG); err != nil || found {
		t.Fatalf("object after lost confirmation found=%t err=%v", found, err)
	}
	assertOutboxCount(t, ctx, pool, scopeA, 1)
	if _, err := pool.Exec(ctx, "DROP TRIGGER fail_test_private_object_confirmation ON vault_object_delete_outbox"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DROP FUNCTION fail_test_private_object_confirmation()"); err != nil {
		t.Fatal(err)
	}
	command.AttemptedAt = 4_100
	assertPrivateObjectPurgeResult(t, service, ctx, command,
		encryptedobject.VaultPrivateObjectPurgeConfirmed, "")
	assertOutboxCount(t, ctx, pool, scopeA, 0)

	keyH := privateObjectPurgeKey(t, 'H')
	seedPrivateObjectOutbox(t, ctx, pool, scopeA, 5_000, keyH)
	command.AttemptedAt = 5_000
	opened, err = directory.Open(ctx, command)
	if err != nil || opened.Kind != encryptedobject.DeleteOutboxOpened {
		t.Fatalf("CAS Open() = %#v, %v", opened, err)
	}
	entries, err := opened.Repository.ListReady(ctx, 5_000, 1)
	if err != nil || len(entries) != 1 {
		t.Fatalf("CAS entries = %#v, %v", entries, err)
	}
	if _, err := pool.Exec(ctx, `UPDATE vault_object_delete_outbox SET attempt_count = 1
		WHERE vault_id = $1 AND object_key = $2`, string(scopeA.VaultID), string(keyH)); err != nil {
		t.Fatal(err)
	}
	mutation, err := opened.Repository.ConfirmDelete(ctx, entries[0])
	if err != nil || mutation.Kind != encryptedobject.DeleteOutboxMutationConflict {
		t.Fatalf("stale confirmation = %#v, %v", mutation, err)
	}
	assertOutboxRetry(t, ctx, pool, scopeA, keyH, 1, 5_000)
	if _, err := pool.Exec(ctx, "DELETE FROM vault_object_delete_outbox WHERE object_key = $1", string(keyH)); err != nil {
		t.Fatal(err)
	}

	assertOtherPrivateObjectState(t, ctx, pool, objectsB, scopeB, keyOther)
	assertPreservedAccountData(t, ctx, pool, scopeA)
	assertRowCount(t, ctx, pool, "entitlement_projections", "vault_id", string(scopeA.VaultID), 1)
	if acquired := pool.Stat().AcquiredConns(); acquired != 0 {
		t.Fatalf("database connections still acquired: %d", acquired)
	}
}

func seedPreservedEntitlement(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	suffix int,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, `INSERT INTO entitlement_projections(
		account_id, vault_id, version, source_subscription_id, source_billing_version,
		state, valid_until, lock_reason, checked_at, created_at, updated_at
	) VALUES ($1, $2, 1, $3, 1, 'locked', NULL, 'cancelled', 1400, 1000, 1400)`,
		string(scope.AccountID), string(scope.VaultID), integrationUUID(t, 6_100+suffix)); err != nil {
		t.Fatalf("seed preserved entitlement: %v", err)
	}
}

func markPrivateObjectPurgeRunning(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	operation accountdeletion.Operation,
	completedAt int64,
) {
	t.Helper()
	tag, err := pool.Exec(ctx, `UPDATE account_deletion_operations SET
		revision = 3, current_step = 'delete-private-objects', updated_at = $1
		WHERE operation_id = $2 AND account_id = $3 AND vault_id = $4
		  AND state = 'running' AND current_step = 'delete-vault-data'`,
		completedAt, string(operation.OperationID), string(operation.Scope.AccountID), string(operation.Scope.VaultID))
	if err != nil || tag.RowsAffected() != 1 {
		t.Fatalf("mark private-object purge running: rows=%d err=%v", tag.RowsAffected(), err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO account_deletion_step_receipts(operation_id, step, completed_at)
		VALUES ($1, 'delete-vault-data', $2)`, string(operation.OperationID), completedAt); err != nil {
		t.Fatalf("seed live-data receipt: %v", err)
	}
}

func privateObjectPurgeCommandForOperation(
	t *testing.T,
	operation accountdeletion.Operation,
	previousReceiptAt, attemptedAt int64,
) encryptedobject.VaultPrivateObjectPurgeCommand {
	t.Helper()
	operationID, err := encryptedobject.ParsePurgeOperationID(string(operation.OperationID))
	if err != nil {
		t.Fatal(err)
	}
	return encryptedobject.VaultPrivateObjectPurgeCommand{
		Scope: encryptedobject.VaultPrivateObjectPurgeScope{
			AccountID: operation.Scope.AccountID, VaultID: operation.Scope.VaultID,
		},
		OperationID: operationID, PreviousReceiptAt: previousReceiptAt, AttemptedAt: attemptedAt,
	}
}

func privateObjectPurgeService(
	t *testing.T,
	scope encryptedobject.VaultPrivateObjectPurgeScope,
	directory encryptedobject.VaultObjectDeleteOutboxDirectory,
	objects encryptedobject.PrivateObjectDeletePort,
	batchLimit int,
	retryDelay int64,
) *encryptedobject.VaultPrivateObjectPurgeService {
	t.Helper()
	service, err := encryptedobject.NewVaultPrivateObjectPurgeService(
		scope, directory, objects,
		encryptedobject.VaultPrivateObjectPurgePolicy{BatchLimit: batchLimit, RetryDelayMilli: retryDelay},
	)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func privateObjectPurgeKey(t *testing.T, fill byte) encryptedobject.ObjectKey {
	t.Helper()
	key, err := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat(string(fill), 43))
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func seedPrivateObjectOutbox(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	createdAt int64,
	keys ...encryptedobject.ObjectKey,
) {
	t.Helper()
	for _, key := range keys {
		if _, err := pool.Exec(ctx, `INSERT INTO vault_object_delete_outbox(
			vault_id, object_key, attempt_count, next_attempt_at, created_at
		) VALUES ($1, $2, 0, $3, $3)`, string(scope.VaultID), string(key), createdAt); err != nil {
			t.Fatalf("seed private-object outbox: %v", err)
		}
	}
}

func putPrivateObjects(
	t *testing.T,
	ctx context.Context,
	objects *objectstorage.Memory,
	createdAt int64,
	keys ...encryptedobject.ObjectKey,
) {
	t.Helper()
	for _, key := range keys {
		result, err := objects.PutIfAbsent(ctx, key, []byte{1, 2, 3}, createdAt)
		if err != nil || result != encryptedobject.PutStored {
			t.Fatalf("put private object %q = %q, %v", key, result, err)
		}
	}
}

func assertPrivateObjectPurgeResult(
	t *testing.T,
	service *encryptedobject.VaultPrivateObjectPurgeService,
	ctx context.Context,
	command encryptedobject.VaultPrivateObjectPurgeCommand,
	kind encryptedobject.VaultPrivateObjectPurgeResultKind,
	reason encryptedobject.VaultPrivateObjectPurgeFailureReason,
) {
	t.Helper()
	result, err := service.PurgeVaultPrivateObjects(ctx, command)
	if err != nil || result.Kind != kind || result.Reason != reason {
		t.Fatalf("PurgeVaultPrivateObjects() = %#v, %v; want kind=%q reason=%q", result, err, kind, reason)
	}
}

func assertOutboxCount(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	want int64,
) {
	t.Helper()
	var count int64
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_object_delete_outbox WHERE vault_id = $1`,
		string(scope.VaultID)).Scan(&count); err != nil || count != want {
		t.Fatalf("outbox count = %d, %v; want %d", count, err, want)
	}
}

func assertOutboxRetry(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	scope accountdeletion.Scope,
	key encryptedobject.ObjectKey,
	wantAttempt, wantNext int64,
) {
	t.Helper()
	var attempt, next int64
	err := pool.QueryRow(ctx, `SELECT attempt_count, next_attempt_at FROM vault_object_delete_outbox
		WHERE vault_id = $1 AND object_key = $2`, string(scope.VaultID), string(key)).Scan(&attempt, &next)
	if err != nil || attempt != wantAttempt || next != wantNext {
		t.Fatalf("outbox retry = %d/%d, %v; want %d/%d", attempt, next, err, wantAttempt, wantNext)
	}
}

func assertOtherPrivateObjectState(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	objects *objectstorage.Memory,
	scope accountdeletion.Scope,
	key encryptedobject.ObjectKey,
) {
	t.Helper()
	assertOutboxCount(t, ctx, pool, scope, 1)
	if _, found, err := objects.Get(ctx, key); err != nil || !found {
		t.Fatalf("other Vault private object found=%t err=%v", found, err)
	}
	if objects.Calls().Delete != 0 {
		t.Fatalf("other Vault delete calls = %d", objects.Calls().Delete)
	}
}
