//go:build integration

package integration_test

import (
	"context"
	"errors"
	"strconv"
	"testing"

	contentcrypto "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5/pgxpool"
)

var errIntegrationCommit = errors.New("injected PostgreSQL commit boundary failure")

func TestEncryptedObjectPostgresCrashResumeIsolationAndOutbox(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultA := cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	vaultB := cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000202")
	seedCryptoVault(t, ctx, pool, "01991f20-61d2-7000-8000-000000000101", vaultA)
	seedCryptoVault(t, ctx, pool, "01991f20-61d2-7000-8000-000000000102", vaultB)
	storeA, err := postgresadapter.NewEncryptedObjectStore(pool, vaultA)
	if err != nil {
		t.Fatal(err)
	}
	storeB, err := postgresadapter.NewEncryptedObjectStore(pool, vaultB)
	if err != nil {
		t.Fatal(err)
	}
	objects, _ := objectstorage.NewMemory(nil)
	keys := &integrationObjectKeys{values: []encryptedobject.ObjectKey{
		integrationObjectKey(t, 'A'), integrationObjectKey(t, 'B'), integrationObjectKey(t, 'C'), integrationObjectKey(t, 'D'),
	}}
	keyring, encryption := integrationObjectEncryption(t, vaultA)
	keyStore, err := postgresadapter.NewVaultDEKStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	if err := keyStore.InsertInitial(ctx, keyring.Versions[0]); err != nil {
		t.Fatal(err)
	}
	failing := &failFirstMetadataCommit{MetadataRepository: storeA, fail: true}
	service, err := encryptedobject.NewService(vaultA, failing, objects, keys, encryption, nil)
	if err != nil {
		t.Fatal(err)
	}
	command := integrationFirstObjectWrite(t, keyring)
	if _, err := service.Write(ctx, command); !errors.Is(err, errIntegrationCommit) {
		t.Fatalf("first write error = %v", err)
	}
	if objects.Calls().Put != 1 || encryption.encrypt != 1 || encryption.decrypt != 0 || keys.calls != 1 {
		t.Fatalf("first attempt calls = %#v, %d/%d, %d", objects.Calls(), encryption.encrypt, encryption.decrypt, keys.calls)
	}

	resumed, err := encryptedobject.NewService(vaultA, storeA, objects, keys, encryption, nil)
	if err != nil {
		t.Fatal(err)
	}
	stored, err := resumed.Write(ctx, command)
	if err != nil || stored.Kind != encryptedobject.WriteStored {
		t.Fatalf("resumed write = %#v, %v", stored, err)
	}
	if objects.Calls().Put != 1 || encryption.encrypt != 1 || encryption.decrypt != 1 || keys.calls != 1 {
		t.Fatalf("resume calls = %#v, %d/%d, %d", objects.Calls(), encryption.encrypt, encryption.decrypt, keys.calls)
	}
	callsBeforeReplay := objects.Calls()
	if replay, err := resumed.Write(ctx, command); err != nil || replay.Kind != encryptedobject.WriteReplayed {
		t.Fatalf("lost response replay = %#v, %v", replay, err)
	}
	if objects.Calls() != callsBeforeReplay || encryption.encrypt != 1 || encryption.decrypt != 1 || keys.calls != 1 {
		t.Fatal("lost response replay repeated an external side effect")
	}
	read, err := resumed.Read(ctx, command.Object, keyring)
	if err != nil || !read.Found || string(read.Plaintext) != string(command.Plaintext) {
		t.Fatalf("read = %#v, %v", read, err)
	}
	if crossVault, err := storeB.FindByWriteID(ctx, command.WriteID); err != nil || crossVault != nil {
		t.Fatalf("cross-vault write lookup = %#v, %v", crossVault, err)
	}
	if crossVault, err := storeB.FindCurrent(ctx, command.Object); err != nil || crossVault != nil {
		t.Fatalf("cross-vault object lookup = %#v, %v", crossVault, err)
	}
	assertConcurrentEncryptedObjectCAS(t, ctx, vaultA, storeA, objects, keyring)

	activeKey := integrationObjectKey(t, 'C')
	activeIntent := encryptedobject.PendingWrite{
		Object:         encryptedobject.ObjectRef{Kind: cryptocontent.ObjectConflict, ObjectID: "01991f20-61d2-7000-8000-000000000003"},
		ObjectRevision: 1, WriteID: integrationWriteID(t, 503), ObjectKey: activeKey,
		PlaintextBytes: 1, CryptoVersion: cryptocontent.EnvelopeCryptoVersion,
		DEKVersion: keyring.WriteVersion, CreatedAtMilli: 1_000,
	}
	if reservation, err := storeA.ReserveIntent(ctx, activeIntent); err != nil || reservation.Kind != encryptedobject.IntentReserved {
		t.Fatalf("active intent reservation = %#v, %v", reservation, err)
	}
	if result, err := objects.PutIfAbsent(ctx, activeKey, []byte{1}, 1_000); err != nil || result != encryptedobject.PutStored {
		t.Fatalf("active object put = %q, %v", result, err)
	}
	if enqueued, err := storeB.EnqueueDelete(ctx, activeKey, 10_000); err != nil || enqueued {
		t.Fatalf("cross-vault active object enqueue = %t, %v", enqueued, err)
	}

	orphanKey := integrationObjectKey(t, 'D')
	if result, err := objects.PutIfAbsent(ctx, orphanKey, []byte{2}, 1_000); err != nil || result != encryptedobject.PutStored {
		t.Fatalf("orphan put = %q, %v", result, err)
	}
	enqueued, err := resumed.CollectOrphans(ctx, 10_000, 1_000)
	if err != nil || enqueued != 1 {
		t.Fatalf("CollectOrphans() = %d, %v", enqueued, err)
	}
	ready, err := storeA.ListReadyDeletes(ctx, 10_000, 10)
	if err != nil || len(ready) != 1 || ready[0].ObjectKey != orphanKey {
		t.Fatalf("ready deletes = %#v, %v", ready, err)
	}
	staleConfirmation := ready[0]
	staleConfirmation.AttemptCount++
	if err := storeA.CompleteDelete(ctx, staleConfirmation); !errors.Is(err, postgresadapter.ErrEncryptedObjectDeleteConflict) {
		t.Fatalf("stale delete confirmation error = %v", err)
	}
	staleReschedule := ready[0]
	staleReschedule.AttemptCount += 2
	staleReschedule.NextAttemptAt = 15_000
	if err := storeA.RescheduleDelete(ctx, staleReschedule); !errors.Is(err, postgresadapter.ErrEncryptedObjectDeleteConflict) {
		t.Fatalf("stale delete reschedule error = %v", err)
	}
	queuedKeyIntent := activeIntent
	queuedKeyIntent.Object = encryptedobject.ObjectRef{Kind: cryptocontent.ObjectConflict, ObjectID: "01991f20-61d2-7000-8000-000000000004"}
	queuedKeyIntent.WriteID = integrationWriteID(t, 506)
	queuedKeyIntent.ObjectKey = orphanKey
	if reservation, err := storeA.ReserveIntent(ctx, queuedKeyIntent); err != nil || reservation.Kind != encryptedobject.IntentConflict {
		t.Fatalf("delete-queued key reservation = %#v, %v", reservation, err)
	}
	objects.FailDeleteForTest(orphanKey)
	completed, retried, err := resumed.DrainDeleteOutbox(ctx, 10_000, 5_000, 10)
	if err != nil || completed != 0 || retried != 1 {
		t.Fatalf("failed drain = %d, %d, %v", completed, retried, err)
	}
	completed, retried, err = resumed.DrainDeleteOutbox(ctx, 14_999, 5_000, 10)
	if err != nil || completed != 0 || retried != 0 {
		t.Fatalf("early drain = %d, %d, %v", completed, retried, err)
	}
	completed, retried, err = resumed.DrainDeleteOutbox(ctx, 15_000, 5_000, 10)
	if err != nil || completed != 1 || retried != 0 {
		t.Fatalf("retry drain = %d, %d, %v", completed, retried, err)
	}
	if _, found, _ := objects.Get(ctx, orphanKey); found {
		t.Fatal("orphan remains after confirmed delete")
	}
	if _, found, _ := objects.Get(ctx, activeKey); !found {
		t.Fatal("active intent object was deleted")
	}
	assertEncryptedObjectSchema(t, ctx, pool)
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

func assertConcurrentEncryptedObjectCAS(
	t *testing.T,
	ctx context.Context,
	vaultID identity.VaultID,
	store *postgresadapter.EncryptedObjectStore,
	objects *objectstorage.Memory,
	keyring cryptocontent.VaultDEKKeyring,
) {
	t.Helper()
	ready := make(chan struct{}, 2)
	release := make(chan struct{})
	newContender := func(fill byte, writeSuffix int, plaintext string) (*encryptedobject.Service, encryptedobject.WriteCommand) {
		repository := &barrierMetadataRepository{
			MetadataRepository: store, ready: ready, release: release,
		}
		_, encryption := integrationObjectEncryption(t, vaultID)
		keys := &integrationObjectKeys{values: []encryptedobject.ObjectKey{integrationObjectKey(t, fill)}}
		service, err := encryptedobject.NewService(vaultID, repository, objects, keys, encryption, nil)
		if err != nil {
			t.Fatal(err)
		}
		expected := cryptocontent.ObjectRevision(1)
		return service, encryptedobject.WriteCommand{
			Object:           encryptedobject.ObjectRef{Kind: cryptocontent.ObjectCard, ObjectID: "01991f20-61d2-7000-8000-000000000001"},
			ExpectedRevision: &expected, NextRevision: 2, WriteID: integrationWriteID(t, writeSuffix),
			Plaintext: []byte(plaintext), Keyring: keyring, CreatedAtMilli: 2_000,
		}
	}
	serviceA, commandA := newContender('E', 504, "concurrent-a")
	serviceB, commandB := newContender('F', 505, "concurrent-b")
	results := make(chan encryptedobject.WriteResult, 2)
	errorsFound := make(chan error, 2)
	before := objects.Calls()
	go func() {
		result, err := serviceA.Write(ctx, commandA)
		results <- result
		errorsFound <- err
	}()
	go func() {
		result, err := serviceB.Write(ctx, commandB)
		results <- result
		errorsFound <- err
	}()
	<-ready
	<-ready
	close(release)
	resultA, resultB := <-results, <-results
	errA, errB := <-errorsFound, <-errorsFound
	if errA != nil || errB != nil {
		t.Fatalf("concurrent writes errors = %v, %v", errA, errB)
	}
	stored, conflicts := 0, 0
	for _, result := range []encryptedobject.WriteResult{resultA, resultB} {
		switch {
		case result.Kind == encryptedobject.WriteStored:
			stored++
		case result.Kind == encryptedobject.WriteNotApplied && result.Reason == encryptedobject.ReasonCASConflict:
			conflicts++
		default:
			t.Fatalf("unexpected concurrent result = %#v", result)
		}
	}
	if stored != 1 || conflicts != 1 || objects.Calls().Put != before.Put+1 {
		t.Fatalf("concurrent outcomes stored=%d conflict=%d calls=%#v before=%#v", stored, conflicts, objects.Calls(), before)
	}
	completed, retried, err := serviceA.DrainDeleteOutbox(ctx, 2_000, 5_000, 10)
	if err != nil || retried != 0 || completed > 1 {
		t.Fatalf("concurrent loser cleanup = %d, %d, %v", completed, retried, err)
	}
}

type failFirstMetadataCommit struct {
	encryptedobject.MetadataRepository
	fail bool
}

type barrierMetadataRepository struct {
	encryptedobject.MetadataRepository
	ready   chan<- struct{}
	release <-chan struct{}
}

func (wrapper *barrierMetadataRepository) FindCurrent(ctx context.Context, object encryptedobject.ObjectRef) (*encryptedobject.Metadata, error) {
	metadata, err := wrapper.MetadataRepository.FindCurrent(ctx, object)
	if err != nil {
		return nil, err
	}
	wrapper.ready <- struct{}{}
	<-wrapper.release
	return metadata, nil
}

func (wrapper *failFirstMetadataCommit) CommitIntent(ctx context.Context, intent encryptedobject.PendingWrite, ciphertextBytes int64) (encryptedobject.MetadataCommit, error) {
	if wrapper.fail {
		wrapper.fail = false
		return encryptedobject.MetadataCommit{}, errIntegrationCommit
	}
	return wrapper.MetadataRepository.CommitIntent(ctx, intent, ciphertextBytes)
}

type integrationObjectKeys struct {
	values []encryptedobject.ObjectKey
	calls  int
}

func (fake *integrationObjectKeys) CreateObjectKey(context.Context) (string, error) {
	if fake.calls >= len(fake.values) {
		return "", errors.New("integration object key fixture exhausted")
	}
	value := fake.values[fake.calls]
	fake.calls++
	return string(value), nil
}

type integrationEncryptionCalls struct {
	base    encryptedobject.EncryptionPort
	encrypt int
	decrypt int
}

func (counted *integrationEncryptionCalls) Encrypt(ctx context.Context, keyring cryptocontent.VaultDEKKeyring, object cryptocontent.ObjectContext, plaintext []byte) (cryptocontent.EnvelopeCiphertext, error) {
	counted.encrypt++
	return counted.base.Encrypt(ctx, keyring, object, plaintext)
}

func (counted *integrationEncryptionCalls) Decrypt(ctx context.Context, keyring cryptocontent.VaultDEKKeyring, object cryptocontent.ObjectContext, ciphertext cryptocontent.EnvelopeCiphertext) ([]byte, error) {
	counted.decrypt++
	return counted.base.Decrypt(ctx, keyring, object, ciphertext)
}

func integrationObjectEncryption(t *testing.T, vaultID identity.VaultID) (cryptocontent.VaultDEKKeyring, *integrationEncryptionCalls) {
	t.Helper()
	version, _ := cryptocontent.ParseDEKVersion(1)
	metadata := cryptoMetadata(vaultID, version, 1_000)
	keyring, err := cryptocontent.NewVaultDEKKeyring(vaultID, version, []cryptocontent.VaultDEKMetadata{metadata})
	if err != nil {
		t.Fatal(err)
	}
	base, err := cryptocontent.NewService(
		&integrationObjectKeyManagement{metadata: metadata},
		&integrationObjectNonces{},
		&integrationObjectReservations{seen: make(map[string]struct{})},
		contentcrypto.AES256GCM{},
	)
	if err != nil {
		t.Fatal(err)
	}
	return keyring, &integrationEncryptionCalls{base: base}
}

type integrationObjectKeyManagement struct {
	metadata cryptocontent.VaultDEKMetadata
}

func (fake *integrationObjectKeyManagement) GenerateDataKey(context.Context, identity.VaultID, cryptocontent.DEKVersion) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	key, err := cryptocontent.NewDataEncryptionKey(make([]byte, 32))
	return fake.metadata, key, err
}

func (fake *integrationObjectKeyManagement) UnwrapDataKey(context.Context, cryptocontent.VaultDEKMetadata) (*cryptocontent.DataEncryptionKey, error) {
	return cryptocontent.NewDataEncryptionKey(make([]byte, 32))
}

type integrationObjectNonces struct{ next byte }

func (fake *integrationObjectNonces) CreateNonce(context.Context) ([]byte, error) {
	value := make([]byte, 12)
	for index := range value {
		value[index] = fake.next
	}
	fake.next++
	return value, nil
}

type integrationObjectReservations struct{ seen map[string]struct{} }

func (fake *integrationObjectReservations) ReserveNonce(_ context.Context, vaultID identity.VaultID, version cryptocontent.DEKVersion, nonce string) (bool, error) {
	key := string(vaultID) + ":" + strconv.FormatInt(int64(version), 10) + ":" + nonce
	if _, found := fake.seen[key]; found {
		return false, nil
	}
	fake.seen[key] = struct{}{}
	return true, nil
}

func integrationFirstObjectWrite(t *testing.T, keyring cryptocontent.VaultDEKKeyring) encryptedobject.WriteCommand {
	t.Helper()
	return encryptedobject.WriteCommand{
		Object:       encryptedobject.ObjectRef{Kind: cryptocontent.ObjectCard, ObjectID: "01991f20-61d2-7000-8000-000000000001"},
		NextRevision: 1, WriteID: integrationWriteID(t, 501), Plaintext: []byte("postgres-crash-resume"),
		Keyring: keyring, CreatedAtMilli: 1_000,
	}
}

func integrationWriteID(t *testing.T, suffix int) encryptedobject.WriteID {
	t.Helper()
	value, err := encryptedobject.ParseWriteID("01991f20-61d2-7000-8000-" + strconv.FormatInt(int64(100_000_000_000+suffix), 10))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func integrationObjectKey(t *testing.T, fill byte) encryptedobject.ObjectKey {
	t.Helper()
	raw := make([]byte, 43)
	for index := range raw {
		raw[index] = fill
	}
	value, err := encryptedobject.ParseObjectKey("obj_v1_" + string(raw))
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func assertEncryptedObjectSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, table := range []string{"vault_encrypted_objects", "vault_encrypted_write_intents", "vault_object_delete_outbox"} {
		var exists bool
		if err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", table).Scan(&exists); err != nil || !exists {
			t.Fatalf("table %s exists = %t, error = %v", table, exists, err)
		}
	}
	var plaintextColumnCount int
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*) FROM information_schema.columns
		  WHERE table_schema = 'public' AND table_name IN (
		    'vault_encrypted_objects', 'vault_encrypted_write_intents', 'vault_object_delete_outbox'
		  ) AND column_name IN ('plaintext', 'ciphertext', 'object_bytes')`,
	).Scan(&plaintextColumnCount); err != nil || plaintextColumnCount != 0 {
		t.Fatalf("secret-bearing database columns = %d, %v", plaintextColumnCount, err)
	}
}
