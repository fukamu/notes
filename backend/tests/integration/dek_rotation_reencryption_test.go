//go:build integration

package integration_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	errLostRotationResponse  = errors.New("injected lost rotation response")
	errLostReencryptResponse = errors.New("injected lost re-encryption response")
)

func TestDEKRotationAndDurableReencryptionPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	accountA, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	accountB, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000102")
	vaultA := cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000201")
	vaultB := cryptoVaultID(t, "01991f20-61d2-7000-8000-000000000202")
	seedCryptoVault(t, ctx, pool, string(accountA), vaultA)
	seedCryptoVault(t, ctx, pool, string(accountB), vaultB)
	keyStore, _ := postgresadapter.NewVaultDEKStore(pool)
	versionOne, _ := cryptocontent.ParseDEKVersion(1)
	versionTwo, _ := cryptocontent.ParseDEKVersion(2)
	if err := keyStore.InsertInitial(ctx, cryptoMetadata(vaultA, versionOne, 1_000)); err != nil {
		t.Fatal(err)
	}
	if err := keyStore.InsertInitial(ctx, cryptoMetadata(vaultB, versionOne, 1_000)); err != nil {
		t.Fatal(err)
	}

	objectStore, _ := postgresadapter.NewEncryptedObjectStore(pool, vaultA)
	objects, _ := objectstorage.NewMemory(nil)
	objectKeys := &integrationObjectKeys{values: []encryptedobject.ObjectKey{
		integrationObjectKey(t, 'A'), integrationObjectKey(t, 'B'),
		integrationObjectKey(t, 'C'), integrationObjectKey(t, 'D'),
	}}
	oldKeyring, encryption := integrationObjectEncryption(t, vaultA)
	objectService, err := encryptedobject.NewService(vaultA, objectStore, objects, objectKeys, encryption, nil)
	if err != nil {
		t.Fatal(err)
	}
	first := integrationFirstObjectWrite(t, oldKeyring)
	if result, err := objectService.Write(ctx, first); err != nil || result.Kind != encryptedobject.WriteStored {
		t.Fatalf("first old object = %#v, %v", result, err)
	}
	second := encryptedobject.WriteCommand{
		Object: encryptedobject.ObjectRef{
			Kind: cryptocontent.ObjectCard, ObjectID: "01991f20-61d2-7000-8000-000000000002",
		},
		NextRevision: 1, WriteID: integrationWriteID(t, 502), Plaintext: []byte("postgres-second-old-object"),
		Keyring: oldKeyring, CreatedAtMilli: 1_100,
	}
	if result, err := objectService.Write(ctx, second); err != nil || result.Kind != encryptedobject.WriteStored {
		t.Fatalf("second old object = %#v, %v", result, err)
	}
	pending := encryptedobject.PendingWrite{
		Object: encryptedobject.ObjectRef{
			Kind: cryptocontent.ObjectConflict, ObjectID: "01991f20-61d2-7000-8000-000000000003",
		},
		ObjectRevision: 1, WriteID: integrationWriteID(t, 503), ObjectKey: integrationObjectKey(t, 'E'),
		PlaintextBytes: 10, CryptoVersion: cryptocontent.EnvelopeCryptoVersion,
		DEKVersion: versionOne, CreatedAtMilli: 1_200,
	}
	if reserved, err := objectStore.ReserveIntent(ctx, pending); err != nil || reserved.Kind != encryptedobject.IntentReserved {
		t.Fatalf("old pending intent = %#v, %v", reserved, err)
	}

	rotationStore, _ := postgresadapter.NewDEKRotationStore(pool)
	scope := cryptocontent.RotationScope{AccountID: accountA, VaultID: vaultA}
	ready := make(chan struct{}, 2)
	release := make(chan struct{})
	barrier := &rotationLoadBarrier{RotationRepository: rotationStore, ready: ready, release: release}
	startKeys := &integrationRotationKeys{metadata: cryptoMetadata(vaultA, versionTwo, 2_100)}
	serviceA, _ := cryptocontent.NewRotationService(barrier, startKeys)
	serviceB, _ := cryptocontent.NewRotationService(barrier, startKeys)
	operationIDs := []cryptocontent.RotationOperationID{
		integrationRotationID(t, "01991f20-61d2-7000-8000-000000000401"),
		integrationRotationID(t, "01991f20-61d2-7000-8000-000000000402"),
	}
	type startOutcome struct {
		result cryptocontent.RotationRunResult
		err    error
	}
	outcomes := make(chan startOutcome, 2)
	for index, service := range []*cryptocontent.RotationService{serviceA, serviceB} {
		index, service := index, service
		go func() {
			result, startErr := service.Start(ctx, scope, operationIDs[index], 2_000)
			outcomes <- startOutcome{result: result, err: startErr}
		}()
	}
	<-ready
	<-ready
	close(release)
	var winner cryptocontent.RotationOperationID
	pendingStarts, conflicts := 0, 0
	for range 2 {
		outcome := <-outcomes
		if outcome.err != nil {
			t.Fatal(outcome.err)
		}
		switch {
		case outcome.result.Kind == cryptocontent.RotationPending && outcome.result.Operation != nil:
			pendingStarts++
			winner = outcome.result.Operation.OperationID
		case outcome.result.Kind == cryptocontent.RotationRunReject && outcome.result.Reason == cryptocontent.RotationRunConflict:
			conflicts++
		default:
			t.Fatalf("unexpected concurrent rotation start = %#v", outcome.result)
		}
	}
	if pendingStarts != 1 || conflicts != 1 {
		t.Fatalf("rotation start outcomes pending=%d conflicts=%d", pendingStarts, conflicts)
	}

	rotationKeys := &integrationRotationKeys{metadata: cryptoMetadata(vaultA, versionTwo, 2_100)}
	lostGenerated := &lostGeneratedResponseRepository{RotationRepository: rotationStore, fail: true}
	rotationService, _ := cryptocontent.NewRotationService(lostGenerated, rotationKeys)
	if _, err := rotationService.Resume(ctx, scope, winner, 2_200); !errors.Is(err, errLostRotationResponse) {
		t.Fatalf("lost generation response error = %v", err)
	}
	if rotationKeys.calls != 1 || rotationKeys.generated == nil || !rotationKeys.generated.Destroyed() {
		t.Fatalf("generated key calls=%d destroyed=%t", rotationKeys.calls, rotationKeys.generated != nil && rotationKeys.generated.Destroyed())
	}
	rotationService, _ = cryptocontent.NewRotationService(rotationStore, rotationKeys)
	completed, err := rotationService.Resume(ctx, scope, winner, 2_300)
	if err != nil || completed.Kind != cryptocontent.RotationFinished || rotationKeys.calls != 1 {
		t.Fatalf("rotation completion = %#v, %v calls=%d", completed, err, rotationKeys.calls)
	}
	if replayed, err := rotationService.Resume(ctx, scope, winner, 2_400); err != nil ||
		replayed.Kind != cryptocontent.RotationFinished || rotationKeys.calls != 1 {
		t.Fatalf("rotation replay = %#v, %v calls=%d", replayed, err, rotationKeys.calls)
	}
	keyring, err := keyStore.FindKeyring(ctx, vaultA)
	if err != nil || keyring == nil || keyring.WriteVersion != versionTwo || len(keyring.Versions) != 2 {
		t.Fatalf("promoted keyring = %#v, %v", keyring, err)
	}
	wrongOwner, err := rotationStore.Load(ctx, cryptocontent.RotationScope{AccountID: accountB, VaultID: vaultA})
	if err != nil || wrongOwner.Kind != cryptocontent.RotationNotFound {
		t.Fatalf("cross-owner rotation load = %#v, %v", wrongOwner, err)
	}
	lateOldIntent := pending
	lateOldIntent.WriteID = integrationWriteID(t, 504)
	lateOldIntent.Object.ObjectID = "01991f20-61d2-7000-8000-000000000004"
	lateOldIntent.ObjectKey = integrationObjectKey(t, 'F')
	if reserved, err := objectStore.ReserveIntent(ctx, lateOldIntent); err != nil || reserved.Kind != encryptedobject.IntentConflict {
		t.Fatalf("old-version intent after promotion = %#v, %v", reserved, err)
	}

	beforeReencrypt := objects.Calls()
	beforeEncrypt, beforeDecrypt, beforeKeys := encryption.encrypt, encryption.decrypt, objectKeys.calls
	lostCommit := &lostReencryptResponseRepository{ReencryptionRepository: objectStore, fail: true}
	reencryptionService, _ := encryptedobject.NewReencryptionService(vaultA, lostCommit, objects, objectKeys, encryption)
	if _, err := reencryptionService.RunBatch(ctx, *keyring, 1, 3_000); !errors.Is(err, errLostReencryptResponse) {
		t.Fatalf("lost re-encryption response error = %v", err)
	}
	reencryptionService, _ = encryptedobject.NewReencryptionService(vaultA, objectStore, objects, objectKeys, encryption)
	resumed, err := reencryptionService.RunBatch(ctx, *keyring, 1, 3_100)
	if err != nil || resumed.Kind != encryptedobject.ReencryptionBatchPending ||
		resumed.Pending != encryptedobject.ReencryptionPendingWrites || resumed.Processed != 1 {
		t.Fatalf("durable re-encryption resume = %#v, %v", resumed, err)
	}
	if objects.Calls().Put != beforeReencrypt.Put+2 || encryption.encrypt != beforeEncrypt+2 ||
		encryption.decrypt != beforeDecrypt+2 || objectKeys.calls != beforeKeys+2 {
		t.Fatalf("re-encryption side effects objects=%#v encryption=%d/%d keys=%d",
			objects.Calls(), encryption.encrypt, encryption.decrypt, objectKeys.calls)
	}
	if err := objectStore.AbandonIntent(ctx, pending, 3_200); err != nil {
		t.Fatal(err)
	}
	finished, err := reencryptionService.RunBatch(ctx, *keyring, 1, 3_300)
	if err != nil || finished.Kind != encryptedobject.ReencryptionBatchCompleted || finished.Processed != 0 {
		t.Fatalf("re-encryption completion = %#v, %v", finished, err)
	}
	callsAtCompletion := objects.Calls()
	if replayed, err := reencryptionService.RunBatch(ctx, *keyring, 1, 3_400); err != nil ||
		replayed.Kind != encryptedobject.ReencryptionBatchCompleted || replayed.Processed != 0 {
		t.Fatalf("re-encryption completed replay = %#v, %v", replayed, err)
	}
	if objects.Calls() != callsAtCompletion || encryption.encrypt != beforeEncrypt+2 ||
		encryption.decrypt != beforeDecrypt+2 || objectKeys.calls != beforeKeys+2 {
		t.Fatal("completed re-encryption replay repeated external work")
	}
	var oldObjects, oldIntents, deleteOutbox int
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_encrypted_objects WHERE vault_id = $1 AND dek_version = 1`, string(vaultA)).Scan(&oldObjects); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_encrypted_write_intents WHERE vault_id = $1 AND dek_version = 1`, string(vaultA)).Scan(&oldIntents); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_object_delete_outbox WHERE vault_id = $1`, string(vaultA)).Scan(&deleteOutbox); err != nil {
		t.Fatal(err)
	}
	if oldObjects != 0 || oldIntents != 0 || deleteOutbox != 3 {
		t.Fatalf("post re-encryption old objects=%d intents=%d outbox=%d", oldObjects, oldIntents, deleteOutbox)
	}
	storeB, _ := postgresadapter.NewEncryptedObjectStore(pool, vaultB)
	inventoryB, err := storeB.Inventory(ctx, versionTwo)
	if err != nil || inventoryB.OlderObjects != 0 || inventoryB.TargetObjects != 0 {
		t.Fatalf("cross-vault inventory = %#v, %v", inventoryB, err)
	}
	assertRotationReencryptionSchema(t, ctx, pool)
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

type rotationLoadBarrier struct {
	cryptocontent.RotationRepository
	ready   chan<- struct{}
	release <-chan struct{}
}

func (wrapper *rotationLoadBarrier) Load(
	ctx context.Context,
	scope cryptocontent.RotationScope,
) (cryptocontent.RotationLoadResult, error) {
	loaded, err := wrapper.RotationRepository.Load(ctx, scope)
	if err == nil {
		wrapper.ready <- struct{}{}
		<-wrapper.release
	}
	return loaded, err
}

type integrationRotationKeys struct {
	mutex     sync.Mutex
	metadata  cryptocontent.VaultDEKMetadata
	generated *cryptocontent.DataEncryptionKey
	calls     int
}

func (fake *integrationRotationKeys) GenerateDataKey(
	context.Context,
	identity.VaultID,
	cryptocontent.DEKVersion,
) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	fake.mutex.Lock()
	defer fake.mutex.Unlock()
	fake.calls++
	key, err := cryptocontent.NewDataEncryptionKey(make([]byte, 32))
	fake.generated = key
	return fake.metadata, key, err
}

func (*integrationRotationKeys) UnwrapDataKey(
	context.Context,
	cryptocontent.VaultDEKMetadata,
) (*cryptocontent.DataEncryptionKey, error) {
	return cryptocontent.NewDataEncryptionKey(make([]byte, 32))
}

type lostGeneratedResponseRepository struct {
	cryptocontent.RotationRepository
	fail bool
}

func (wrapper *lostGeneratedResponseRepository) RecordGenerated(
	ctx context.Context,
	scope cryptocontent.RotationScope,
	transition cryptocontent.RotationTransition,
) (cryptocontent.RotationCommitResult, error) {
	result, err := wrapper.RotationRepository.RecordGenerated(ctx, scope, transition)
	if err == nil && wrapper.fail {
		wrapper.fail = false
		return result, errLostRotationResponse
	}
	return result, err
}

type lostReencryptResponseRepository struct {
	encryptedobject.ReencryptionRepository
	fail bool
}

func (wrapper *lostReencryptResponseRepository) CommitReplacement(
	ctx context.Context,
	expected encryptedobject.Metadata,
	replacement encryptedobject.Metadata,
	expectedJob encryptedobject.ReencryptionJob,
	nextJob encryptedobject.ReencryptionJob,
	requestedAt int64,
) (encryptedobject.ReencryptionCommitResult, error) {
	result, err := wrapper.ReencryptionRepository.CommitReplacement(
		ctx, expected, replacement, expectedJob, nextJob, requestedAt,
	)
	if err == nil && wrapper.fail && result.Kind == encryptedobject.ReencryptionApplied {
		wrapper.fail = false
		return result, errLostReencryptResponse
	}
	return result, err
}

func integrationRotationID(t *testing.T, raw string) cryptocontent.RotationOperationID {
	t.Helper()
	value, err := cryptocontent.ParseRotationOperationID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func assertRotationReencryptionSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, table := range []string{"vault_dek_rotation_operations", "vault_reencryption_jobs"} {
		var exists bool
		if err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", table).Scan(&exists); err != nil || !exists {
			t.Fatalf("table %s exists = %t, error = %v", table, exists, err)
		}
	}
	var secretColumns int
	if err := pool.QueryRow(
		ctx,
		`SELECT COUNT(*) FROM information_schema.columns
		  WHERE table_schema = 'public'
		    AND table_name IN ('vault_dek_rotation_operations', 'vault_reencryption_jobs')
		    AND column_name IN ('raw_dek', 'plaintext', 'ciphertext', 'object_bytes')`,
	).Scan(&secretColumns); err != nil || secretColumns != 0 {
		t.Fatalf("rotation/re-encryption secret columns = %d, %v", secretColumns, err)
	}
}
