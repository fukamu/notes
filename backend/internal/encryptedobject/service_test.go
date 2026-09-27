package encryptedobject_test

import (
	"context"
	"errors"
	"sort"
	"strconv"
	"testing"

	contentcrypto "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

var errInjectedCommit = errors.New("injected metadata commit failure")

func TestServiceReplaysLostResponseWithoutNewSideEffects(t *testing.T) {
	fixture := newServiceFixture(t)
	command := firstWrite(t, fixture.keyring)

	stored, err := fixture.service.Write(context.Background(), command)
	if err != nil || stored.Kind != encryptedobject.WriteStored {
		t.Fatalf("first Write() = %#v, %v", stored, err)
	}
	objectCalls := fixture.objects.Calls()
	cryptoCalls := fixture.encryption.calls()
	keyCalls := fixture.keys.calls
	replayed, err := fixture.service.Write(context.Background(), command)
	if err != nil || replayed.Kind != encryptedobject.WriteReplayed || replayed.Metadata != stored.Metadata {
		t.Fatalf("replayed Write() = %#v, %v", replayed, err)
	}
	if fixture.objects.Calls() != objectCalls || fixture.encryption.calls() != cryptoCalls || fixture.keys.calls != keyCalls {
		t.Fatalf("replay side effects: objects=%#v crypto=%#v keys=%d", fixture.objects.Calls(), fixture.encryption.calls(), fixture.keys.calls)
	}
	read, err := fixture.service.Read(context.Background(), command.Object, fixture.keyring)
	if err != nil || !read.Found || string(read.Plaintext) != string(command.Plaintext) {
		t.Fatalf("Read() = %#v, %v", read, err)
	}
}

func TestServiceResumesSameObjectAfterCommitFailureAndCleansCASLoser(t *testing.T) {
	fixture := newServiceFixture(t)
	fixture.repository.failCommitOnce = true
	command := firstWrite(t, fixture.keyring)

	if _, err := fixture.service.Write(context.Background(), command); !errors.Is(err, errInjectedCommit) {
		t.Fatalf("first Write() error = %v", err)
	}
	if fixture.objects.Calls().Put != 1 || fixture.encryption.calls() != (cryptoCalls{Encrypt: 1}) || fixture.keys.calls != 1 {
		t.Fatalf("first attempt calls = %#v %#v %d", fixture.objects.Calls(), fixture.encryption.calls(), fixture.keys.calls)
	}
	stored, err := fixture.service.Write(context.Background(), command)
	if err != nil || stored.Kind != encryptedobject.WriteStored {
		t.Fatalf("resumed Write() = %#v, %v", stored, err)
	}
	if fixture.objects.Calls().Put != 1 || fixture.encryption.calls() != (cryptoCalls{Encrypt: 1, Decrypt: 1}) || fixture.keys.calls != 1 {
		t.Fatalf("resume calls = %#v %#v %d", fixture.objects.Calls(), fixture.encryption.calls(), fixture.keys.calls)
	}

	fixture.repository.rejectCommit = true
	second := secondRevisionWrite(t, fixture.keyring)
	rejected, err := fixture.service.Write(context.Background(), second)
	if err != nil || rejected.Kind != encryptedobject.WriteNotApplied || rejected.Reason != encryptedobject.ReasonCASConflict {
		t.Fatalf("CAS loser = %#v, %v", rejected, err)
	}
	if _, found, _ := fixture.objects.Get(context.Background(), fixture.keys.values[1]); !found {
		t.Fatal("CAS loser object was deleted synchronously")
	}
	completed, retried, err := fixture.service.DrainDeleteOutbox(context.Background(), 2_000, 5_000, 10)
	if err != nil || completed != 1 || retried != 0 {
		t.Fatalf("DrainDeleteOutbox() = %d, %d, %v", completed, retried, err)
	}
	if _, found, _ := fixture.objects.Get(context.Background(), fixture.keys.values[1]); found {
		t.Fatal("CAS loser object remains after outbox drain")
	}
}

func TestServiceFailsClosedForCiphertextSwapAndRetriesDelete(t *testing.T) {
	fixture := newServiceFixture(t)
	first := firstWrite(t, fixture.keyring)
	if result, err := fixture.service.Write(context.Background(), first); err != nil || result.Kind != encryptedobject.WriteStored {
		t.Fatalf("first Write() = %#v, %v", result, err)
	}
	second := secondObjectWrite(t, fixture.keyring)
	if result, err := fixture.service.Write(context.Background(), second); err != nil || result.Kind != encryptedobject.WriteStored {
		t.Fatalf("second Write() = %#v, %v", result, err)
	}
	secondBytes, found, err := fixture.objects.Get(context.Background(), fixture.keys.values[1])
	if err != nil || !found {
		t.Fatal("second ciphertext missing")
	}
	if err := fixture.objects.ReplaceForTest(fixture.keys.values[0], secondBytes); err != nil {
		t.Fatal(err)
	}
	if _, err := fixture.service.Read(context.Background(), first.Object, fixture.keyring); !errors.Is(err, encryptedobject.ErrIntegrity) {
		t.Fatalf("ciphertext swap error = %v", err)
	}

	orphanKey := mustObjectKey(t, "obj_v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC")
	orphanStorage, _ := objectstorage.NewMemory([]objectstorage.Seed{{ObjectKey: orphanKey, Bytes: []byte{1}, CreatedAtMilli: 1_000}})
	orphanService, err := encryptedobject.NewService(fixture.vaultID, fixture.repository, orphanStorage, fixture.keys, fixture.encryption, nil)
	if err != nil {
		t.Fatal(err)
	}
	enqueued, err := orphanService.CollectOrphans(context.Background(), 10_000, 1_000)
	if err != nil || enqueued != 1 {
		t.Fatalf("CollectOrphans() = %d, %v", enqueued, err)
	}
	orphanStorage.FailDeleteForTest(orphanKey)
	completed, retried, err := orphanService.DrainDeleteOutbox(context.Background(), 10_000, 5_000, 10)
	if err != nil || completed != 0 || retried != 1 {
		t.Fatalf("first drain = %d, %d, %v", completed, retried, err)
	}
	completed, retried, err = orphanService.DrainDeleteOutbox(context.Background(), 14_999, 5_000, 10)
	if err != nil || completed != 0 || retried != 0 {
		t.Fatalf("early drain = %d, %d, %v", completed, retried, err)
	}
	completed, retried, err = orphanService.DrainDeleteOutbox(context.Background(), 15_000, 5_000, 10)
	if err != nil || completed != 1 || retried != 0 {
		t.Fatalf("retry drain = %d, %d, %v", completed, retried, err)
	}
}

func TestServiceRejectsCiphertextAboveLimitBeforeUpload(t *testing.T) {
	fixture := newServiceFixture(t)
	limit := int64(1)
	service, err := encryptedobject.NewService(
		fixture.vaultID,
		fixture.repository,
		fixture.objects,
		fixture.keys,
		fixture.encryption,
		&limit,
	)
	if err != nil {
		t.Fatal(err)
	}
	command := firstWrite(t, fixture.keyring)
	result, err := service.Write(context.Background(), command)
	if err != nil || result.Kind != encryptedobject.WriteNotApplied || result.Reason != encryptedobject.ReasonCiphertextLimit {
		t.Fatalf("Write() = %#v, %v", result, err)
	}
	if fixture.objects.Calls().Put != 0 {
		t.Fatal("oversized ciphertext was uploaded")
	}
	if intent, _ := fixture.repository.FindIntent(context.Background(), command.WriteID); intent != nil {
		t.Fatal("oversized write intent remains active")
	}
}

type serviceFixture struct {
	vaultID    identity.VaultID
	keyring    cryptocontent.VaultDEKKeyring
	repository *memoryRepository
	objects    *objectstorage.Memory
	keys       *fakeObjectKeys
	encryption *countedEncryption
	service    *encryptedobject.Service
}

func newServiceFixture(t *testing.T) serviceFixture {
	t.Helper()
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	version, _ := cryptocontent.ParseDEKVersion(1)
	metadata := cryptocontent.VaultDEKMetadata{
		VaultID: vaultID, DEKVersion: version, KEKReference: "fake-kek",
		WrappedDEK: "ZmFrZS13cmFwcGVk", CreatedAtMilli: 1_000,
	}
	keyring, err := cryptocontent.NewVaultDEKKeyring(vaultID, version, []cryptocontent.VaultDEKMetadata{metadata})
	if err != nil {
		t.Fatal(err)
	}
	cryptoService, err := cryptocontent.NewService(
		&fakeKeyManagement{metadata: metadata}, &fakeNonces{}, &fakeReservations{seen: make(map[string]struct{})}, contentcrypto.AES256GCM{},
	)
	if err != nil {
		t.Fatal(err)
	}
	repository := newMemoryRepository()
	objects, _ := objectstorage.NewMemory(nil)
	keys := &fakeObjectKeys{values: []encryptedobject.ObjectKey{
		mustObjectKey(t, "obj_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
		mustObjectKey(t, "obj_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
		mustObjectKey(t, "obj_v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
	}}
	encryption := &countedEncryption{base: cryptoService}
	service, err := encryptedobject.NewService(vaultID, repository, objects, keys, encryption, nil)
	if err != nil {
		t.Fatal(err)
	}
	return serviceFixture{
		vaultID: vaultID, keyring: keyring, repository: repository, objects: objects,
		keys: keys, encryption: encryption, service: service,
	}
}

func firstWrite(t *testing.T, keyring cryptocontent.VaultDEKKeyring) encryptedobject.WriteCommand {
	t.Helper()
	return encryptedobject.WriteCommand{
		Object:       encryptedobject.ObjectRef{Kind: cryptocontent.ObjectCard, ObjectID: "01991f20-61d2-7000-8000-000000000001"},
		NextRevision: 1, WriteID: mustWriteID(t, "01991f20-61d2-7000-8000-000000000501"),
		Plaintext: []byte("same-size-card-a"), Keyring: keyring, CreatedAtMilli: 1_000,
	}
}

func secondRevisionWrite(t *testing.T, keyring cryptocontent.VaultDEKKeyring) encryptedobject.WriteCommand {
	t.Helper()
	expected := cryptocontent.ObjectRevision(1)
	return encryptedobject.WriteCommand{
		Object: firstWrite(t, keyring).Object, ExpectedRevision: &expected, NextRevision: 2,
		WriteID:   mustWriteID(t, "01991f20-61d2-7000-8000-000000000502"),
		Plaintext: []byte("revision-two-data"), Keyring: keyring, CreatedAtMilli: 2_000,
	}
}

func secondObjectWrite(t *testing.T, keyring cryptocontent.VaultDEKKeyring) encryptedobject.WriteCommand {
	t.Helper()
	return encryptedobject.WriteCommand{
		Object:       encryptedobject.ObjectRef{Kind: cryptocontent.ObjectCard, ObjectID: "01991f20-61d2-7000-8000-000000000002"},
		NextRevision: 1, WriteID: mustWriteID(t, "01991f20-61d2-7000-8000-000000000502"),
		Plaintext: []byte("same-size-card-b"), Keyring: keyring, CreatedAtMilli: 1_000,
	}
}

type cryptoCalls struct{ Encrypt, Decrypt int }

type countedEncryption struct {
	base    encryptedobject.EncryptionPort
	encrypt int
	decrypt int
}

func (counted *countedEncryption) Encrypt(ctx context.Context, keyring cryptocontent.VaultDEKKeyring, object cryptocontent.ObjectContext, plaintext []byte) (cryptocontent.EnvelopeCiphertext, error) {
	counted.encrypt++
	return counted.base.Encrypt(ctx, keyring, object, plaintext)
}

func (counted *countedEncryption) Decrypt(ctx context.Context, keyring cryptocontent.VaultDEKKeyring, object cryptocontent.ObjectContext, ciphertext cryptocontent.EnvelopeCiphertext) ([]byte, error) {
	counted.decrypt++
	return counted.base.Decrypt(ctx, keyring, object, ciphertext)
}

func (counted *countedEncryption) calls() cryptoCalls {
	return cryptoCalls{Encrypt: counted.encrypt, Decrypt: counted.decrypt}
}

type fakeKeyManagement struct {
	metadata cryptocontent.VaultDEKMetadata
}

func (fake *fakeKeyManagement) GenerateDataKey(context.Context, identity.VaultID, cryptocontent.DEKVersion) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	key, err := cryptocontent.NewDataEncryptionKey(make([]byte, 32))
	return fake.metadata, key, err
}

func (fake *fakeKeyManagement) UnwrapDataKey(context.Context, cryptocontent.VaultDEKMetadata) (*cryptocontent.DataEncryptionKey, error) {
	return cryptocontent.NewDataEncryptionKey(make([]byte, 32))
}

type fakeNonces struct{ next byte }

func (fake *fakeNonces) CreateNonce(context.Context) ([]byte, error) {
	value := make([]byte, 12)
	for index := range value {
		value[index] = fake.next
	}
	fake.next++
	return value, nil
}

type fakeReservations struct{ seen map[string]struct{} }

func (fake *fakeReservations) ReserveNonce(_ context.Context, vaultID identity.VaultID, version cryptocontent.DEKVersion, nonce string) (bool, error) {
	key := string(vaultID) + ":" + strconv.FormatInt(int64(version), 10) + ":" + nonce
	if _, found := fake.seen[key]; found {
		return false, nil
	}
	fake.seen[key] = struct{}{}
	return true, nil
}

type fakeObjectKeys struct {
	values []encryptedobject.ObjectKey
	calls  int
}

func (fake *fakeObjectKeys) CreateObjectKey(context.Context) (string, error) {
	if fake.calls >= len(fake.values) {
		return "", errors.New("fake object keys exhausted")
	}
	value := fake.values[fake.calls]
	fake.calls++
	return string(value), nil
}

type memoryRepository struct {
	metadata       []encryptedobject.Metadata
	intents        map[encryptedobject.WriteID]encryptedobject.PendingWrite
	outbox         map[encryptedobject.ObjectKey]encryptedobject.DeleteOutboxEntry
	failCommitOnce bool
	rejectCommit   bool
}

func newMemoryRepository() *memoryRepository {
	return &memoryRepository{
		intents: make(map[encryptedobject.WriteID]encryptedobject.PendingWrite),
		outbox:  make(map[encryptedobject.ObjectKey]encryptedobject.DeleteOutboxEntry),
	}
}

func (repo *memoryRepository) FindCurrent(_ context.Context, object encryptedobject.ObjectRef) (*encryptedobject.Metadata, error) {
	var found *encryptedobject.Metadata
	for _, metadata := range repo.metadata {
		if encryptedobject.SameObject(metadata.Object, object) && (found == nil || metadata.ObjectRevision > found.ObjectRevision) {
			copyOfMetadata := metadata
			found = &copyOfMetadata
		}
	}
	return found, nil
}

func (repo *memoryRepository) FindRevision(_ context.Context, object encryptedobject.ObjectRef, revision cryptocontent.ObjectRevision) (*encryptedobject.Metadata, error) {
	for _, metadata := range repo.metadata {
		if encryptedobject.SameObject(metadata.Object, object) && metadata.ObjectRevision == revision {
			copyOfMetadata := metadata
			return &copyOfMetadata, nil
		}
	}
	return nil, nil
}

func (repo *memoryRepository) FindByWriteID(_ context.Context, writeID encryptedobject.WriteID) (*encryptedobject.Metadata, error) {
	for _, metadata := range repo.metadata {
		if metadata.WriteID == writeID {
			copyOfMetadata := metadata
			return &copyOfMetadata, nil
		}
	}
	return nil, nil
}

func (repo *memoryRepository) FindIntent(_ context.Context, writeID encryptedobject.WriteID) (*encryptedobject.PendingWrite, error) {
	intent, found := repo.intents[writeID]
	if !found {
		return nil, nil
	}
	return &intent, nil
}

func (repo *memoryRepository) ReserveIntent(_ context.Context, intent encryptedobject.PendingWrite) (encryptedobject.IntentReservation, error) {
	if existing, found := repo.intents[intent.WriteID]; found {
		return encryptedobject.IntentReservation{Kind: encryptedobject.IntentExisting, Intent: existing}, nil
	}
	for _, existing := range repo.intents {
		if (encryptedobject.SameObject(existing.Object, intent.Object) && existing.ObjectRevision == intent.ObjectRevision) || existing.ObjectKey == intent.ObjectKey {
			return encryptedobject.IntentReservation{Kind: encryptedobject.IntentConflict}, nil
		}
	}
	repo.intents[intent.WriteID] = intent
	return encryptedobject.IntentReservation{Kind: encryptedobject.IntentReserved, Intent: intent}, nil
}

func (repo *memoryRepository) CommitIntent(_ context.Context, intent encryptedobject.PendingWrite, ciphertextBytes int64) (encryptedobject.MetadataCommit, error) {
	if repo.failCommitOnce {
		repo.failCommitOnce = false
		return encryptedobject.MetadataCommit{}, errInjectedCommit
	}
	if repo.rejectCommit {
		return encryptedobject.MetadataCommit{Kind: encryptedobject.MetadataNotApplied}, nil
	}
	current, _ := repo.FindCurrent(context.Background(), intent.Object)
	if (intent.ExpectedRevision == nil && current != nil) ||
		(intent.ExpectedRevision != nil && (current == nil || current.ObjectRevision != *intent.ExpectedRevision)) {
		return encryptedobject.MetadataCommit{Kind: encryptedobject.MetadataNotApplied}, nil
	}
	metadata := encryptedobject.Metadata{
		Object: intent.Object, ObjectRevision: intent.ObjectRevision, WriteID: intent.WriteID,
		ObjectKey: intent.ObjectKey, PlaintextBytes: intent.PlaintextBytes, CiphertextBytes: ciphertextBytes,
		CryptoVersion: intent.CryptoVersion, DEKVersion: intent.DEKVersion, CreatedAtMilli: intent.CreatedAtMilli,
	}
	repo.metadata = append(repo.metadata, metadata)
	delete(repo.intents, intent.WriteID)
	return encryptedobject.MetadataCommit{Kind: encryptedobject.MetadataApplied, Metadata: metadata}, nil
}

func (repo *memoryRepository) AbandonIntent(_ context.Context, intent encryptedobject.PendingWrite, requestedAt int64) error {
	repo.outbox[intent.ObjectKey] = encryptedobject.DeleteOutboxEntry{
		ObjectKey: intent.ObjectKey, NextAttemptAt: requestedAt, CreatedAtMilli: requestedAt,
	}
	delete(repo.intents, intent.WriteID)
	return nil
}

func (repo *memoryRepository) ListProtectedObjectKeys(context.Context) (map[encryptedobject.ObjectKey]struct{}, error) {
	result := make(map[encryptedobject.ObjectKey]struct{})
	for _, metadata := range repo.metadata {
		result[metadata.ObjectKey] = struct{}{}
	}
	for _, intent := range repo.intents {
		result[intent.ObjectKey] = struct{}{}
	}
	for objectKey := range repo.outbox {
		result[objectKey] = struct{}{}
	}
	return result, nil
}

func (repo *memoryRepository) EnqueueDelete(_ context.Context, objectKey encryptedobject.ObjectKey, requestedAt int64) (bool, error) {
	protected, _ := repo.ListProtectedObjectKeys(context.Background())
	if _, found := protected[objectKey]; found {
		return false, nil
	}
	if _, found := repo.outbox[objectKey]; found {
		return false, nil
	}
	repo.outbox[objectKey] = encryptedobject.DeleteOutboxEntry{ObjectKey: objectKey, NextAttemptAt: requestedAt, CreatedAtMilli: requestedAt}
	return true, nil
}

func (repo *memoryRepository) ListReadyDeletes(_ context.Context, now int64, limit int) ([]encryptedobject.DeleteOutboxEntry, error) {
	result := make([]encryptedobject.DeleteOutboxEntry, 0)
	for _, entry := range repo.outbox {
		if entry.NextAttemptAt <= now {
			result = append(result, entry)
		}
	}
	sort.Slice(result, func(left, right int) bool {
		if result[left].NextAttemptAt == result[right].NextAttemptAt {
			return result[left].ObjectKey < result[right].ObjectKey
		}
		return result[left].NextAttemptAt < result[right].NextAttemptAt
	})
	if len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (repo *memoryRepository) CompleteDelete(_ context.Context, entry encryptedobject.DeleteOutboxEntry) error {
	delete(repo.outbox, entry.ObjectKey)
	return nil
}

func (repo *memoryRepository) RescheduleDelete(_ context.Context, entry encryptedobject.DeleteOutboxEntry) error {
	repo.outbox[entry.ObjectKey] = entry
	return nil
}

func mustWriteID(t *testing.T, raw string) encryptedobject.WriteID {
	t.Helper()
	value, err := encryptedobject.ParseWriteID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func mustObjectKey(t *testing.T, raw string) encryptedobject.ObjectKey {
	t.Helper()
	value, err := encryptedobject.ParseObjectKey(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}
