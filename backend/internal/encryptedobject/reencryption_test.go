package encryptedobject_test

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	contentcrypto "github.com/fukamu/notes/backend/internal/adapters/contentcrypto"
	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

var errReencryptionKMS = errors.New("injected re-encryption KMS failure")

func TestReencryptionCorePlansInventoryCandidateAndCheckpoint(t *testing.T) {
	if plan := encryptedobject.EvaluateReencryptionInventory(encryptedobject.ReencryptionInventory{
		OwnerPresent: true, OlderObjects: 1,
	}); plan.Kind != encryptedobject.ReencryptionInventoryScan {
		t.Fatalf("scan plan = %#v", plan)
	}
	if plan := encryptedobject.EvaluateReencryptionInventory(encryptedobject.ReencryptionInventory{
		OwnerPresent: true, OlderWriteIntents: 1,
	}); plan.Kind != encryptedobject.ReencryptionInventoryWait {
		t.Fatalf("pending plan = %#v", plan)
	}
	if plan := encryptedobject.EvaluateReencryptionInventory(encryptedobject.ReencryptionInventory{
		OwnerPresent: true, NewerObjects: 1,
	}); plan.Kind != encryptedobject.ReencryptionInventoryReject || plan.Reason != encryptedobject.ReencryptionNewerVersion {
		t.Fatalf("newer plan = %#v", plan)
	}

	candidate := reencryptionCandidate(t)
	replacementKey := mustObjectKey(t, "obj_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB")
	planned := encryptedobject.PlanReencryptionCandidate(candidate, 2, replacementKey, candidate.CiphertextBytes+1)
	if !planned.Accepted || planned.Replacement.ObjectKey != replacementKey ||
		planned.Replacement.DEKVersion != 2 || planned.Replacement.ObjectRevision != candidate.ObjectRevision {
		t.Fatalf("candidate plan = %#v", planned)
	}
	if reused := encryptedobject.PlanReencryptionCandidate(candidate, 2, candidate.ObjectKey, candidate.CiphertextBytes); reused.Accepted || reused.Reason != encryptedobject.ReencryptionObjectKeyReuse {
		t.Fatalf("reused key = %#v", reused)
	}

	job := encryptedobject.ReencryptionJob{
		TargetVersion: 2, State: encryptedobject.ReencryptionRunning,
		Revision: 1, CreatedAtMilli: 1_000, UpdatedAtMilli: 1_000,
	}
	position := encryptedobject.PositionFor(candidate)
	next, err := encryptedobject.AdvanceReencryptionJob(job, &position, encryptedobject.ReencryptionRunning, 2_000)
	if err != nil || next.Revision != 2 || next.After == nil ||
		encryptedobject.CompareReencryptionPosition(*next.After, position) != 0 {
		t.Fatalf("checkpoint = %#v, %v", next, err)
	}
	completed, err := encryptedobject.AdvanceReencryptionJob(next, nil, encryptedobject.ReencryptionCompleted, 2_100)
	if err != nil || completed.State != encryptedobject.ReencryptionCompleted || completed.After != nil {
		t.Fatalf("completed checkpoint = %#v, %v", completed, err)
	}
}

func TestReencryptionServicePersistsProgressAndCompletedReplayHasNoExternalWork(t *testing.T) {
	fixture := newReencryptionFixture(t)
	result, err := fixture.service.RunBatch(context.Background(), fixture.keyring, 1, 2_000)
	if err != nil || result.Kind != encryptedobject.ReencryptionBatchCompleted || result.Processed != 1 ||
		result.Job == nil || result.Job.State != encryptedobject.ReencryptionCompleted {
		t.Fatalf("RunBatch() = %#v, %v", result, err)
	}
	if fixture.encryption.encrypt != 1 || fixture.encryption.decrypt != 1 || fixture.keys.calls != 1 ||
		fixture.objects.Calls().Put != 2 || len(fixture.repository.outbox) != 1 {
		t.Fatalf("calls encrypt/decrypt/key/object/outbox = %d/%d/%d/%#v/%d",
			fixture.encryption.encrypt, fixture.encryption.decrypt, fixture.keys.calls,
			fixture.objects.Calls(), len(fixture.repository.outbox))
	}
	calls := fixture.objects.Calls()
	replayed, err := fixture.service.RunBatch(context.Background(), fixture.keyring, 1, 3_000)
	if err != nil || replayed.Kind != encryptedobject.ReencryptionBatchCompleted || replayed.Processed != 0 {
		t.Fatalf("completed replay = %#v, %v", replayed, err)
	}
	if fixture.objects.Calls() != calls || fixture.encryption.encrypt != 1 ||
		fixture.encryption.decrypt != 1 || fixture.keys.calls != 1 {
		t.Fatal("completed replay repeated object, crypto, or key work")
	}
}

func TestReencryptionServiceKeepsCheckpointOnCASConflictAndWaitsForOldIntents(t *testing.T) {
	fixture := newReencryptionFixture(t)
	fixture.repository.rejectCommit = true
	result, err := fixture.service.RunBatch(context.Background(), fixture.keyring, 1, 2_000)
	if err != nil || result.Kind != encryptedobject.ReencryptionBatchPending ||
		result.Pending != encryptedobject.ReencryptionCASConflict || result.Processed != 0 ||
		result.Job == nil || result.Job.After != nil {
		t.Fatalf("CAS conflict = %#v, %v", result, err)
	}

	waiting := newReencryptionFixture(t)
	waiting.repository.metadata = nil
	waiting.repository.olderWriteIntents = 1
	before := waiting.objects.Calls()
	result, err = waiting.service.RunBatch(context.Background(), waiting.keyring, 1, 2_000)
	if err != nil || result.Kind != encryptedobject.ReencryptionBatchPending ||
		result.Pending != encryptedobject.ReencryptionPendingWrites || result.Processed != 0 {
		t.Fatalf("pending writes = %#v, %v", result, err)
	}
	if waiting.objects.Calls() != before || waiting.encryption.encrypt != 0 ||
		waiting.encryption.decrypt != 0 || waiting.keys.calls != 0 {
		t.Fatal("pending writes performed external work")
	}
}

func TestReencryptionServiceFailsClosedForCiphertextSwap(t *testing.T) {
	fixture := newReencryptionFixture(t)
	bytes, found, err := fixture.objects.Get(context.Background(), fixture.candidate.ObjectKey)
	if err != nil || !found {
		t.Fatal("fixture object missing")
	}
	var ciphertext cryptocontent.EnvelopeCiphertext
	if err := json.Unmarshal(bytes, &ciphertext); err != nil {
		t.Fatal(err)
	}
	ciphertext.SealedPayload = "AAAAAAAAAAAAAAAAAAAAAA"
	tampered, _ := json.Marshal(ciphertext)
	otherKey := mustObjectKey(t, "obj_v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC")
	if put, err := fixture.objects.PutIfAbsent(context.Background(), otherKey, tampered, 1_000); err != nil || put != encryptedobject.PutStored {
		t.Fatalf("tampered put = %s, %v", put, err)
	}
	fixture.candidate.ObjectKey = otherKey
	fixture.candidate.CiphertextBytes = int64(len(tampered))
	fixture.repository.metadata[0] = fixture.candidate
	if _, err := fixture.service.RunBatch(context.Background(), fixture.keyring, 1, 2_000); !errors.Is(err, encryptedobject.ErrIntegrity) {
		t.Fatalf("tampered error = %v", err)
	}
}

func TestReencryptionServiceRetriesStorageAndKMSFailuresWithoutCheckpointAdvance(t *testing.T) {
	storageFailure := newReencryptionFixture(t)
	storageFailure.objects.FailNext(objectstorage.OperationGet)
	if _, err := storageFailure.service.RunBatch(context.Background(), storageFailure.keyring, 1, 2_000); !errors.Is(err, objectstorage.ErrMemoryOperation) {
		t.Fatalf("storage error = %v", err)
	}
	if storageFailure.repository.job == nil || storageFailure.repository.job.After != nil ||
		storageFailure.repository.job.State != encryptedobject.ReencryptionRunning {
		t.Fatalf("checkpoint advanced after storage failure: %#v", storageFailure.repository.job)
	}
	if retried, err := storageFailure.service.RunBatch(context.Background(), storageFailure.keyring, 1, 2_100); err != nil || retried.Kind != encryptedobject.ReencryptionBatchCompleted {
		t.Fatalf("storage retry = %#v, %v", retried, err)
	}

	kmsFailure := newReencryptionFixture(t)
	kmsFailure.encryption.base = failingReencryptionEncryption{}
	if _, err := kmsFailure.service.RunBatch(context.Background(), kmsFailure.keyring, 1, 2_000); !errors.Is(err, encryptedobject.ErrIntegrity) {
		t.Fatalf("KMS error = %v", err)
	}
	if kmsFailure.repository.job == nil || kmsFailure.repository.job.After != nil ||
		kmsFailure.repository.job.State != encryptedobject.ReencryptionRunning || kmsFailure.keys.calls != 0 {
		t.Fatalf("checkpoint/key work after KMS failure: job=%#v keys=%d", kmsFailure.repository.job, kmsFailure.keys.calls)
	}
}

func TestReencryptionServiceResetsDurableScanWhenRowsAppearBehindCheckpoint(t *testing.T) {
	fixture := newReencryptionFixture(t)
	high := encryptedobject.ReencryptionPosition{
		Object: encryptedobject.ObjectRef{
			Kind: cryptocontent.ObjectConflict, ObjectID: "01991f20-61d2-7000-8000-000000000099",
		},
		ObjectRevision: 1,
	}
	fixture.repository.job = &encryptedobject.ReencryptionJob{
		TargetVersion: 2, After: &high, State: encryptedobject.ReencryptionRunning,
		Revision: 4, CreatedAtMilli: 1_000, UpdatedAtMilli: 1_500,
	}
	result, err := fixture.service.RunBatch(context.Background(), fixture.keyring, 1, 2_000)
	if err != nil || result.Kind != encryptedobject.ReencryptionBatchPending ||
		result.Pending != encryptedobject.ReencryptionRestartScan || result.Job == nil || result.Job.After != nil {
		t.Fatalf("restart scan = %#v, %v", result, err)
	}
}

type reencryptionFixture struct {
	keyring    cryptocontent.VaultDEKKeyring
	candidate  encryptedobject.Metadata
	repository *reencryptionRepositoryFake
	objects    *objectstorage.Memory
	keys       *fakeObjectKeys
	encryption *countedEncryption
	service    *encryptedobject.ReencryptionService
}

type failingReencryptionEncryption struct{}

func (failingReencryptionEncryption) Encrypt(
	context.Context,
	cryptocontent.VaultDEKKeyring,
	cryptocontent.ObjectContext,
	[]byte,
) (cryptocontent.EnvelopeCiphertext, error) {
	return cryptocontent.EnvelopeCiphertext{}, errReencryptionKMS
}

func (failingReencryptionEncryption) Decrypt(
	context.Context,
	cryptocontent.VaultDEKKeyring,
	cryptocontent.ObjectContext,
	cryptocontent.EnvelopeCiphertext,
) ([]byte, error) {
	return nil, errReencryptionKMS
}

func newReencryptionFixture(t *testing.T) reencryptionFixture {
	t.Helper()
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	if err != nil {
		t.Fatal(err)
	}
	oldMetadata := cryptocontent.VaultDEKMetadata{
		VaultID: vaultID, DEKVersion: 1, KEKReference: "projects/test/keys/test/versions/1",
		WrappedDEK: "d3JhcHBlZA", CreatedAtMilli: 500,
	}
	newMetadata := oldMetadata
	newMetadata.DEKVersion = 2
	newMetadata.CreatedAtMilli = 1_500
	keyring, err := cryptocontent.NewVaultDEKKeyring(vaultID, 2, []cryptocontent.VaultDEKMetadata{oldMetadata, newMetadata})
	if err != nil {
		t.Fatal(err)
	}
	oldKeyring, _ := cryptocontent.NewVaultDEKKeyring(vaultID, 1, []cryptocontent.VaultDEKMetadata{oldMetadata})
	cryptoService, err := cryptocontent.NewService(
		&fakeKeyManagement{metadata: oldMetadata}, &fakeNonces{},
		&fakeReservations{seen: make(map[string]struct{})}, contentcrypto.AES256GCM{},
	)
	if err != nil {
		t.Fatal(err)
	}
	object := encryptedobject.ObjectRef{
		Kind: cryptocontent.ObjectCard, ObjectID: "01991f20-61d2-7000-8000-000000000001",
	}
	plaintext := []byte("old encrypted card")
	ciphertext, err := cryptoService.Encrypt(context.Background(), oldKeyring, cryptocontent.ObjectContext{
		VaultID: vaultID, Kind: object.Kind, ObjectID: object.ObjectID, ObjectRevision: 1,
	}, plaintext)
	if err != nil {
		t.Fatal(err)
	}
	encoded, _ := json.Marshal(ciphertext)
	oldObjectKey := mustObjectKey(t, "obj_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	candidate := encryptedobject.Metadata{
		Object: object, ObjectRevision: 1,
		WriteID: mustWriteID(t, "01991f20-61d2-7000-8000-000000000501"), ObjectKey: oldObjectKey,
		PlaintextBytes: int64(len(plaintext)), CiphertextBytes: int64(len(encoded)),
		CryptoVersion: cryptocontent.EnvelopeCryptoVersion, DEKVersion: 1, CreatedAtMilli: 1_000,
	}
	objects, _ := objectstorage.NewMemory(nil)
	if put, err := objects.PutIfAbsent(context.Background(), oldObjectKey, encoded, 1_000); err != nil || put != encryptedobject.PutStored {
		t.Fatalf("old object put = %s, %v", put, err)
	}
	repository := &reencryptionRepositoryFake{metadata: []encryptedobject.Metadata{candidate}}
	keys := &fakeObjectKeys{values: []encryptedobject.ObjectKey{
		mustObjectKey(t, "obj_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
	}}
	encryption := &countedEncryption{base: cryptoService}
	service, err := encryptedobject.NewReencryptionService(vaultID, repository, objects, keys, encryption)
	if err != nil {
		t.Fatal(err)
	}
	return reencryptionFixture{
		keyring: keyring, candidate: candidate, repository: repository,
		objects: objects, keys: keys, encryption: encryption, service: service,
	}
}

type reencryptionRepositoryFake struct {
	job               *encryptedobject.ReencryptionJob
	metadata          []encryptedobject.Metadata
	olderWriteIntents int64
	rejectCommit      bool
	outbox            []encryptedobject.ObjectKey
}

func (fake *reencryptionRepositoryFake) LoadOrStartJob(
	_ context.Context,
	target cryptocontent.DEKVersion,
	requestedAt int64,
) (encryptedobject.ReencryptionJob, error) {
	if fake.job == nil {
		fake.job = &encryptedobject.ReencryptionJob{
			TargetVersion: target, State: encryptedobject.ReencryptionRunning,
			Revision: 1, CreatedAtMilli: requestedAt, UpdatedAtMilli: requestedAt,
		}
	}
	return copyReencryptionJob(*fake.job), nil
}

func (fake *reencryptionRepositoryFake) Inventory(
	_ context.Context,
	target cryptocontent.DEKVersion,
) (encryptedobject.ReencryptionInventory, error) {
	inventory := encryptedobject.ReencryptionInventory{OwnerPresent: true, OlderWriteIntents: fake.olderWriteIntents}
	for _, metadata := range fake.metadata {
		switch {
		case metadata.DEKVersion < target:
			inventory.OlderObjects++
		case metadata.DEKVersion == target:
			inventory.TargetObjects++
		default:
			inventory.NewerObjects++
		}
	}
	return inventory, nil
}

func (fake *reencryptionRepositoryFake) ListCandidates(
	_ context.Context,
	target cryptocontent.DEKVersion,
	after *encryptedobject.ReencryptionPosition,
	limit int,
) ([]encryptedobject.Metadata, error) {
	result := make([]encryptedobject.Metadata, 0, limit)
	for _, metadata := range fake.metadata {
		position := encryptedobject.PositionFor(metadata)
		if metadata.DEKVersion < target && (after == nil || encryptedobject.CompareReencryptionPosition(position, *after) > 0) {
			result = append(result, metadata)
		}
	}
	encryptedobject.SortReencryptionCandidates(result)
	if len(result) > limit {
		result = result[:limit]
	}
	return result, nil
}

func (fake *reencryptionRepositoryFake) CommitReplacement(
	_ context.Context,
	expected encryptedobject.Metadata,
	replacement encryptedobject.Metadata,
	expectedJob encryptedobject.ReencryptionJob,
	nextJob encryptedobject.ReencryptionJob,
	_ int64,
) (encryptedobject.ReencryptionCommitResult, error) {
	if fake.rejectCommit {
		return encryptedobject.ReencryptionCommitResult{Kind: encryptedobject.ReencryptionConflict}, nil
	}
	if fake.job == nil || !sameTestReencryptionJob(*fake.job, expectedJob) {
		return encryptedobject.ReencryptionCommitResult{Kind: encryptedobject.ReencryptionConflict}, nil
	}
	for index, current := range fake.metadata {
		if encryptedobject.SameMetadata(current, expected) {
			fake.metadata[index] = replacement
			fake.outbox = append(fake.outbox, expected.ObjectKey)
			job := copyReencryptionJob(nextJob)
			fake.job = &job
			return encryptedobject.ReencryptionCommitResult{Kind: encryptedobject.ReencryptionApplied, Job: &job}, nil
		}
	}
	return encryptedobject.ReencryptionCommitResult{Kind: encryptedobject.ReencryptionConflict}, nil
}

func (fake *reencryptionRepositoryFake) UpdateJob(
	_ context.Context,
	expected encryptedobject.ReencryptionJob,
	next encryptedobject.ReencryptionJob,
) (encryptedobject.ReencryptionCommitResult, error) {
	if fake.job == nil || !sameTestReencryptionJob(*fake.job, expected) {
		return encryptedobject.ReencryptionCommitResult{Kind: encryptedobject.ReencryptionConflict}, nil
	}
	job := copyReencryptionJob(next)
	fake.job = &job
	return encryptedobject.ReencryptionCommitResult{Kind: encryptedobject.ReencryptionApplied, Job: &job}, nil
}

func reencryptionCandidate(t *testing.T) encryptedobject.Metadata {
	t.Helper()
	return encryptedobject.Metadata{
		Object: encryptedobject.ObjectRef{
			Kind: cryptocontent.ObjectCard, ObjectID: "01991f20-61d2-7000-8000-000000000001",
		},
		ObjectRevision: 1, WriteID: mustWriteID(t, "01991f20-61d2-7000-8000-000000000501"),
		ObjectKey:      mustObjectKey(t, "obj_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
		PlaintextBytes: 10, CiphertextBytes: 100,
		CryptoVersion: cryptocontent.EnvelopeCryptoVersion, DEKVersion: 1, CreatedAtMilli: 1_000,
	}
}

func copyReencryptionJob(job encryptedobject.ReencryptionJob) encryptedobject.ReencryptionJob {
	if job.After != nil {
		position := *job.After
		job.After = &position
	}
	return job
}

func sameTestReencryptionJob(left, right encryptedobject.ReencryptionJob) bool {
	if left.TargetVersion != right.TargetVersion || left.State != right.State || left.Revision != right.Revision ||
		left.CreatedAtMilli != right.CreatedAtMilli || left.UpdatedAtMilli != right.UpdatedAtMilli {
		return false
	}
	if left.After == nil || right.After == nil {
		return left.After == nil && right.After == nil
	}
	return encryptedobject.CompareReencryptionPosition(*left.After, *right.After) == 0
}
