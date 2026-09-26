//go:build integration

package integration_test

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestScopedDeleteOutboxRunnerBoundsRetriesAndProtectsReferencedObjects(t *testing.T) {
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
	seedScopedDeleteOutbox(t, ctx, pool, vaultA, 1_000, keys[0], keys[1], keys[2])
	seedScopedDeleteOutbox(t, ctx, pool, vaultA, 3_000, keys[3])
	seedScopedDeleteOutbox(t, ctx, pool, vaultB, 1_000, keys[4])
	seedScopedDeleteOutbox(t, ctx, pool, vaultA, 1_000, keys[5], keys[6])
	seedProtectedDeleteOutboxKeys(t, ctx, pool, vaultA, keys[5], keys[6])

	objects, err := objectstorage.NewMemory([]objectstorage.Seed{
		{ObjectKey: keys[0], Bytes: []byte{1}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[2], Bytes: []byte{3}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[3], Bytes: []byte{4}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[4], Bytes: []byte{5}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[5], Bytes: []byte{6}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[6], Bytes: []byte{7}, CreatedAtMilli: 1_000},
	})
	if err != nil {
		t.Fatal(err)
	}
	command := operations.DeleteOutboxCommand{
		Scope:       operations.DeleteOutboxScope{AccountID: accountA, VaultID: vaultA},
		AttemptedAt: 2_000, RetryDelayMilli: 500, Limit: 2,
	}
	loader, _ := postgresadapter.NewDeleteOutboxScopeStore(pool)
	repository, _ := postgresadapter.NewScopedDeleteOutboxStore(pool, command.Scope)
	drainer, _ := encryptedobject.NewDeleteOutboxDrainer(repository, objects)
	runner, _ := operations.NewDeleteOutboxService(command.Scope, loader, drainer)

	wrongOwner := command
	wrongOwner.Scope.AccountID = accountB
	refused, err := runner.Run(ctx, wrongOwner)
	if err != nil || refused.Kind != operations.DeleteOutboxRefused || objects.Calls().Delete != 0 {
		t.Fatalf("owner refusal = %#v, error=%v, calls=%#v", refused, err, objects.Calls())
	}
	owned, err := loader.OwnsDeleteOutboxScope(ctx, wrongOwner)
	if err != nil || owned {
		t.Fatalf("cross-owner lookup = %t, %v", owned, err)
	}

	first, err := runner.Run(ctx, command)
	if err != nil || first != (operations.DeleteOutboxResult{
		Kind: operations.DeleteOutboxPending, Completed: 2,
	}) {
		t.Fatalf("first drain = %#v, %v", first, err)
	}
	objects.FailDeleteForTest(keys[2])
	retry, err := runner.Run(ctx, command)
	if err != nil || retry != (operations.DeleteOutboxResult{
		Kind: operations.DeleteOutboxPending, Retried: 1,
	}) {
		t.Fatalf("retry scheduling = %#v, %v", retry, err)
	}
	assertScopedDeleteOutboxRetry(t, ctx, pool, vaultA, keys[2], 1, 2_500)

	command.AttemptedAt = 2_499
	early, err := runner.Run(ctx, command)
	if err != nil || early != (operations.DeleteOutboxResult{Kind: operations.DeleteOutboxPending}) {
		t.Fatalf("early retry = %#v, %v", early, err)
	}
	if objects.Calls().Delete != 3 {
		t.Fatalf("early retry delete calls = %d", objects.Calls().Delete)
	}
	command.AttemptedAt = 2_500
	completedRetry, err := runner.Run(ctx, command)
	if err != nil || completedRetry != (operations.DeleteOutboxResult{
		Kind: operations.DeleteOutboxPending, Completed: 1,
	}) {
		t.Fatalf("completed retry = %#v, %v", completedRetry, err)
	}
	command.AttemptedAt = 3_000
	future, err := runner.Run(ctx, command)
	if err != nil || future != (operations.DeleteOutboxResult{
		Kind: operations.DeleteOutboxPending, Completed: 1,
	}) {
		t.Fatalf("future drain = %#v, %v", future, err)
	}

	assertScopedDeleteOutboxCount(t, ctx, pool, vaultA, 2)
	assertScopedDeleteOutboxCount(t, ctx, pool, vaultB, 1)
	for _, key := range []encryptedobject.ObjectKey{keys[4], keys[5], keys[6]} {
		if _, found, err := objects.Get(ctx, key); err != nil || !found {
			t.Fatalf("protected object %q found=%t err=%v", key, found, err)
		}
	}
	if objects.Calls().Delete != 5 {
		t.Fatalf("bounded delete calls = %d", objects.Calls().Delete)
	}
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

func TestScopedDeleteOutboxRunnerClassifiesConcurrentReplayAndCASConflict(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000111")
	vaultID := cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000211")
	seedCryptoVault(t, ctx, pool, string(accountID), vaultID)
	key := integrationObjectKey(t, 'H')
	seedScopedDeleteOutbox(t, ctx, pool, vaultID, 1_000, key)

	command := operations.DeleteOutboxCommand{
		Scope:       operations.DeleteOutboxScope{AccountID: accountID, VaultID: vaultID},
		AttemptedAt: 2_000, RetryDelayMilli: 500, Limit: 1,
	}
	storage := &blockingDeletePort{started: make(chan struct{}, 2), release: make(chan struct{})}
	runners := make([]*operations.DeleteOutboxService, 2)
	for index := range runners {
		loader, _ := postgresadapter.NewDeleteOutboxScopeStore(pool)
		repository, _ := postgresadapter.NewScopedDeleteOutboxStore(pool, command.Scope)
		drainer, _ := encryptedobject.NewDeleteOutboxDrainer(repository, storage)
		runners[index], _ = operations.NewDeleteOutboxService(command.Scope, loader, drainer)
	}
	type invocation struct {
		result operations.DeleteOutboxResult
		err    error
	}
	results := make(chan invocation, 2)
	for _, runner := range runners {
		go func(value *operations.DeleteOutboxService) {
			result, err := value.Run(ctx, command)
			results <- invocation{result: result, err: err}
		}(runner)
	}
	for range 2 {
		select {
		case <-storage.started:
		case <-time.After(5 * time.Second):
			t.Fatal("concurrent drain did not reach object deletion")
		}
	}
	close(storage.release)
	var completed, replayed int
	for range 2 {
		invocation := <-results
		if invocation.err != nil {
			t.Fatal(invocation.err)
		}
		completed += invocation.result.Completed
		replayed += invocation.result.Replayed
	}
	if completed != 1 || replayed != 1 || storage.calls.Load() != 2 {
		t.Fatalf("completed=%d replayed=%d deleteCalls=%d", completed, replayed, storage.calls.Load())
	}
	assertScopedDeleteOutboxCount(t, ctx, pool, vaultID, 0)

	conflictKey := integrationObjectKey(t, 'I')
	seedScopedDeleteOutbox(t, ctx, pool, vaultID, 3_000, conflictKey)
	repository, _ := postgresadapter.NewScopedDeleteOutboxStore(pool, command.Scope)
	entries, err := repository.ListReady(ctx, 3_000, 1)
	if err != nil || len(entries) != 1 {
		t.Fatalf("conflict entries = %#v, %v", entries, err)
	}
	if _, err := pool.Exec(
		ctx,
		`UPDATE vault_object_delete_outbox SET attempt_count = 1
		  WHERE vault_id = $1 AND object_key = $2`,
		string(vaultID), string(conflictKey),
	); err != nil {
		t.Fatal(err)
	}
	mutation, err := repository.ConfirmDelete(ctx, entries[0])
	if err != nil || mutation.Kind != encryptedobject.DeleteOutboxMutationConflict {
		t.Fatalf("stale confirmation = %#v, %v", mutation, err)
	}
	assertScopedDeleteOutboxRetry(t, ctx, pool, vaultID, conflictKey, 1, 3_000)
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

type blockingDeletePort struct {
	started chan struct{}
	release chan struct{}
	calls   atomic.Int64
}

func (port *blockingDeletePort) Delete(
	ctx context.Context,
	_ encryptedobject.ObjectKey,
) (encryptedobject.DeleteResult, error) {
	port.calls.Add(1)
	port.started <- struct{}{}
	select {
	case <-port.release:
		return encryptedobject.DeleteNotFound, nil
	case <-ctx.Done():
		return "", ctx.Err()
	}
}

func seedScopedDeleteOutbox(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	vaultID identity.VaultID,
	nextAttemptAt int64,
	keys ...encryptedobject.ObjectKey,
) {
	t.Helper()
	for _, key := range keys {
		if _, err := pool.Exec(
			ctx,
			`INSERT INTO vault_object_delete_outbox(
			   vault_id, object_key, attempt_count, next_attempt_at, created_at
			 ) VALUES ($1, $2, 0, $3, $3)`,
			string(vaultID), string(key), nextAttemptAt,
		); err != nil {
			t.Fatal(err)
		}
	}
}

func seedProtectedDeleteOutboxKeys(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	vaultID identity.VaultID,
	committedKey encryptedobject.ObjectKey,
	intentKey encryptedobject.ObjectKey,
) {
	t.Helper()
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO vault_encrypted_objects(
		   vault_id, object_type, object_id, object_revision, write_id, object_key,
		   plaintext_bytes, ciphertext_bytes, crypto_version, dek_version, created_at
		 ) VALUES ($1, 'card', '01991f20-61d2-7000-8000-000000000031', 1,
		   '01991f20-61d2-7000-8000-000000000531', $2, 1, 1,
		   'fukamu-envelope-aes-256-gcm/v1', 1, 1000)`,
		string(vaultID), string(committedKey),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO vault_encrypted_write_intents(
		   vault_id, write_id, object_type, object_id, expected_revision, object_revision,
		   object_key, plaintext_bytes, crypto_version, dek_version, created_at
		 ) VALUES ($1, '01991f20-61d2-7000-8000-000000000532', 'card',
		   '01991f20-61d2-7000-8000-000000000032', NULL, 1, $2, 1,
		   'fukamu-envelope-aes-256-gcm/v1', 1, 1000)`,
		string(vaultID), string(intentKey),
	); err != nil {
		t.Fatal(err)
	}
}

func assertScopedDeleteOutboxCount(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	vaultID identity.VaultID,
	want int,
) {
	t.Helper()
	var count int
	if err := pool.QueryRow(
		ctx,
		"SELECT COUNT(*) FROM vault_object_delete_outbox WHERE vault_id = $1",
		string(vaultID),
	).Scan(&count); err != nil || count != want {
		t.Fatalf("outbox count=%d err=%v want=%d", count, err, want)
	}
}

func assertScopedDeleteOutboxRetry(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	vaultID identity.VaultID,
	key encryptedobject.ObjectKey,
	wantAttempt, wantNext int64,
) {
	t.Helper()
	var attempt, next int64
	if err := pool.QueryRow(
		ctx,
		`SELECT attempt_count, next_attempt_at FROM vault_object_delete_outbox
		  WHERE vault_id = $1 AND object_key = $2`,
		string(vaultID), string(key),
	).Scan(&attempt, &next); err != nil || attempt != wantAttempt || next != wantNext {
		t.Fatalf("retry attempt=%d next=%d err=%v", attempt, next, err)
	}
}
