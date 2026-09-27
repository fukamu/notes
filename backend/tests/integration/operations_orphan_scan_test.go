//go:build integration

package integration_test

import (
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
)

func TestScopedOrphanScanRunnerProtectsGlobalInventoryAndResumesBoundedBatches(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	accountA, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	accountB, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000102")
	vaultA := cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	vaultB := cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000202")
	seedCryptoVault(t, ctx, pool, string(accountA), vaultA)
	seedCryptoVault(t, ctx, pool, string(accountB), vaultB)

	keys := []encryptedobject.ObjectKey{
		integrationObjectKey(t, 'A'), integrationObjectKey(t, 'B'),
		integrationObjectKey(t, 'C'), integrationObjectKey(t, 'D'),
		integrationObjectKey(t, 'E'), integrationObjectKey(t, 'F'),
		integrationObjectKey(t, 'G'),
	}
	objects, err := objectstorage.NewMemory([]objectstorage.Seed{
		{ObjectKey: keys[0], Bytes: []byte{1}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[1], Bytes: []byte{1}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[2], Bytes: []byte{1}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[3], Bytes: []byte{1}, CreatedAtMilli: 9_000},
		{ObjectKey: keys[4], Bytes: []byte{1}, CreatedAtMilli: 9_001},
		{ObjectKey: keys[5], Bytes: []byte{1}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[6], Bytes: []byte{1}, CreatedAtMilli: 1_000},
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO vault_encrypted_objects(
		   vault_id, object_type, object_id, object_revision, write_id, object_key,
		   plaintext_bytes, ciphertext_bytes, crypto_version, dek_version, created_at
		 ) VALUES ($1, 'card', '01991f20-61d2-7000-8000-000000000011', 1,
		   '01991f20-61d2-7000-8000-000000000511', $2, 1, 1,
		   'fukamu-envelope-aes-256-gcm/v1', 1, 1000)`,
		string(vaultB), string(keys[0]),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO vault_encrypted_write_intents(
		   vault_id, write_id, object_type, object_id, expected_revision, object_revision,
		   object_key, plaintext_bytes, crypto_version, dek_version, created_at
		 ) VALUES ($1, '01991f20-61d2-7000-8000-000000000512', 'card',
		   '01991f20-61d2-7000-8000-000000000012', NULL, 1, $2, 1,
		   'fukamu-envelope-aes-256-gcm/v1', 1, 1000)`,
		string(vaultB), string(keys[5]),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO vault_object_delete_outbox(
		   vault_id, object_key, attempt_count, next_attempt_at, created_at
		 ) VALUES ($1, $2, 0, 1000, 1000)`,
		string(vaultB), string(keys[6]),
	); err != nil {
		t.Fatal(err)
	}

	loader, _ := postgresadapter.NewOrphanScanScopeStore(pool)
	repository, _ := postgresadapter.NewEncryptedObjectStore(pool, vaultA)
	collector, _ := encryptedobject.NewOrphanCollector(repository, objects)
	runner, _ := operations.NewOrphanScanService(loader, collector)
	command := operations.OrphanScanCommand{
		AccountID: accountA, VaultID: vaultA,
		ScanStartedAt: 10_000, GracePeriodMilli: 1_000, Limit: 2,
	}

	wrongOwner := command
	wrongOwner.AccountID = accountB
	refused, err := runner.Run(ctx, wrongOwner)
	if err != nil || refused.Kind != operations.OrphanScanRefused || objects.Calls().List != 0 {
		t.Fatalf("owner refusal = %#v, error=%v, calls=%#v", refused, err, objects.Calls())
	}
	objects.FailNext(objectstorage.OperationList)
	if result, err := runner.Run(ctx, command); result != (operations.OrphanScanResult{}) ||
		!errors.Is(err, objectstorage.ErrMemoryOperation) {
		t.Fatalf("inventory failure = %#v, %v", result, err)
	}

	first, err := runner.Run(ctx, command)
	if err != nil || first != (operations.OrphanScanResult{Kind: operations.OrphanScanPending, Enqueued: 2}) {
		t.Fatalf("first batch = %#v, %v", first, err)
	}
	second, err := runner.Run(ctx, command)
	if err != nil || second != (operations.OrphanScanResult{Kind: operations.OrphanScanCompleted, Enqueued: 1}) {
		t.Fatalf("second batch = %#v, %v", second, err)
	}
	replayed, err := runner.Run(ctx, command)
	if err != nil || replayed != (operations.OrphanScanResult{Kind: operations.OrphanScanCompleted}) {
		t.Fatalf("replay = %#v, %v", replayed, err)
	}

	var total, vaultACount, protectedCount int
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM vault_object_delete_outbox").Scan(&total); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(
		ctx,
		"SELECT COUNT(*) FROM vault_object_delete_outbox WHERE vault_id = $1",
		string(vaultA),
	).Scan(&vaultACount); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(
		ctx,
		`SELECT COUNT(*) FROM vault_object_delete_outbox
		  WHERE object_key = ANY($1::text[])`,
		[]string{string(keys[0]), string(keys[4]), string(keys[5])},
	).Scan(&protectedCount); err != nil {
		t.Fatal(err)
	}
	if total != 4 || vaultACount != 3 || protectedCount != 0 {
		t.Fatalf("outbox total=%d vaultA=%d protected=%d", total, vaultACount, protectedCount)
	}
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}
