package cryptocontent_test

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestRotationCoreLifecycleReplayAndValidation(t *testing.T) {
	scope := rotationScope(t)
	source := rotationMetadata(scope.VaultID, 1, 1_000)
	keyring := rotationKeyring(t, scope.VaultID, 1, source)
	operationID := rotationOperationID(t, "01991f20-61d2-7000-8000-000000000401")

	started := cryptocontent.PlanRotationStart(scope, keyring, nil, operationID, 2_000)
	if started.Kind != cryptocontent.RotationStartAccepted || started.Next == nil {
		t.Fatalf("start = %#v", started)
	}
	if replay := cryptocontent.PlanRotationStart(scope, keyring, started.Next, operationID, 2_001); replay.Kind != cryptocontent.RotationStartReplayed {
		t.Fatalf("replay = %#v", replay)
	}
	otherID := rotationOperationID(t, "01991f20-61d2-7000-8000-000000000402")
	if active := cryptocontent.PlanRotationStart(scope, keyring, started.Next, otherID, 2_001); active.Kind != cryptocontent.RotationStartRejected || active.Reason != cryptocontent.RotationActive {
		t.Fatalf("active = %#v", active)
	}

	target := rotationMetadata(scope.VaultID, 2, 2_100)
	generated := cryptocontent.PlanRotationGenerated(*started.Next, target, 2_200)
	if !generated.Accepted || !cryptocontent.ValidRotationTransition(generated.Transition) {
		t.Fatalf("generated = %#v", generated)
	}
	wrongVault := rotationMetadata(rotationVaultID(t, "01991f20-61d2-7000-8000-000000000299"), 2, 2_100)
	if invalid := cryptocontent.PlanRotationGenerated(*started.Next, wrongVault, 2_200); invalid.Accepted || invalid.Reason != cryptocontent.RotationInvalidMetadata {
		t.Fatalf("invalid metadata = %#v", invalid)
	}

	promotingKeyring := rotationKeyring(t, scope.VaultID, 1, source)
	completed := cryptocontent.PlanRotationPromotion(generated.Transition.Next, promotingKeyring, 2_300)
	if !completed.Accepted || !cryptocontent.ValidRotationTransition(completed.Transition) {
		t.Fatalf("completed = %#v", completed)
	}
	completedKeyring := rotationKeyring(t, scope.VaultID, 2, source, target)
	if !cryptocontent.ValidRotationSnapshot(cryptocontent.RotationSnapshot{
		Keyring: completedKeyring, Operation: &completed.Transition.Next,
	}) {
		t.Fatal("completed mixed-version snapshot rejected")
	}
	if cryptocontent.ValidRotationSnapshot(cryptocontent.RotationSnapshot{
		Keyring: keyring, Operation: &completed.Transition.Next,
	}) {
		t.Fatal("completed rotation accepted without the target key")
	}
	next := cryptocontent.PlanRotationStart(scope, completedKeyring, &completed.Transition.Next, otherID, 2_400)
	if next.Kind != cryptocontent.RotationStartAccepted || next.Next == nil || next.Next.SourceVersion != 2 || next.Next.TargetVersion != 3 {
		t.Fatalf("next rotation = %#v", next)
	}
}

func TestRotationServiceDestroysGeneratedKeyAndDoesNotRepeatCompletedWork(t *testing.T) {
	scope := rotationScope(t)
	source := rotationMetadata(scope.VaultID, 1, 1_000)
	repository := &rotationRepositoryFake{snapshot: cryptocontent.RotationSnapshot{
		Keyring: rotationKeyring(t, scope.VaultID, 1, source),
	}}
	target := rotationMetadata(scope.VaultID, 2, 2_100)
	keys := &rotationKeysFake{metadata: target}
	service, err := cryptocontent.NewRotationService(repository, keys)
	if err != nil {
		t.Fatal(err)
	}
	operationID := rotationOperationID(t, "01991f20-61d2-7000-8000-000000000401")
	started, err := service.Start(context.Background(), scope, operationID, 2_000)
	if err != nil || started.Kind != cryptocontent.RotationPending {
		t.Fatalf("start = %#v, %v", started, err)
	}
	generated, err := service.Resume(context.Background(), scope, operationID, 2_200)
	if err != nil || generated.Kind != cryptocontent.RotationPending || keys.generated == nil || !keys.generated.Destroyed() {
		t.Fatalf("generated = %#v, %v, destroyed=%t", generated, err, keys.generated != nil && keys.generated.Destroyed())
	}
	completed, err := service.Resume(context.Background(), scope, operationID, 2_300)
	if err != nil || completed.Kind != cryptocontent.RotationFinished || keys.calls != 1 {
		t.Fatalf("completed = %#v, %v, calls=%d", completed, err, keys.calls)
	}
	replayed, err := service.Resume(context.Background(), scope, operationID, 2_400)
	if err != nil || replayed.Kind != cryptocontent.RotationFinished || keys.calls != 1 {
		t.Fatalf("completed replay = %#v, %v, calls=%d", replayed, err, keys.calls)
	}

	invalidRepository := &rotationRepositoryFake{snapshot: cryptocontent.RotationSnapshot{
		Keyring: rotationKeyring(t, scope.VaultID, 1, source),
	}}
	invalidKeys := &rotationKeysFake{metadata: rotationMetadata(scope.VaultID, 1, 2_100)}
	invalidService, _ := cryptocontent.NewRotationService(invalidRepository, invalidKeys)
	_, _ = invalidService.Start(context.Background(), scope, operationID, 2_000)
	invalidResult, err := invalidService.Resume(context.Background(), scope, operationID, 2_200)
	if err != nil || invalidResult.Kind != cryptocontent.RotationRunReject ||
		invalidKeys.generated == nil || !invalidKeys.generated.Destroyed() {
		t.Fatalf("invalid generation = %#v, %v", invalidResult, err)
	}
}

func TestRotationServiceLeavesGeneratingCheckpointAfterKMSFailure(t *testing.T) {
	scope := rotationScope(t)
	source := rotationMetadata(scope.VaultID, 1, 1_000)
	repository := &rotationRepositoryFake{snapshot: cryptocontent.RotationSnapshot{
		Keyring: rotationKeyring(t, scope.VaultID, 1, source),
	}}
	keys := &rotationKeysFake{metadata: rotationMetadata(scope.VaultID, 2, 2_100), fail: true}
	service, _ := cryptocontent.NewRotationService(repository, keys)
	operationID := rotationOperationID(t, "01991f20-61d2-7000-8000-000000000401")
	if _, err := service.Start(context.Background(), scope, operationID, 2_000); err != nil {
		t.Fatal(err)
	}
	if _, err := service.Resume(context.Background(), scope, operationID, 2_200); !errors.Is(err, errFakeKMS) {
		t.Fatalf("KMS error = %v", err)
	}
	if keys.generated == nil || !keys.generated.Destroyed() {
		t.Fatal("partially returned KMS key was not destroyed")
	}
	if repository.snapshot.Operation == nil {
		t.Fatal("rotation operation disappeared")
	}
	if _, generating := repository.snapshot.Operation.State.(cryptocontent.RotationGenerating); !generating {
		t.Fatalf("state after KMS failure = %#v", repository.snapshot.Operation.State)
	}
}

type rotationRepositoryFake struct {
	snapshot cryptocontent.RotationSnapshot
}

func (fake *rotationRepositoryFake) Load(
	context.Context,
	cryptocontent.RotationScope,
) (cryptocontent.RotationLoadResult, error) {
	return cryptocontent.RotationLoadResult{Kind: cryptocontent.RotationFound, Snapshot: fake.snapshot}, nil
}

func (fake *rotationRepositoryFake) Start(
	_ context.Context,
	_ cryptocontent.RotationScope,
	plan cryptocontent.RotationStartPlan,
) (cryptocontent.RotationCommitResult, error) {
	if plan.Next == nil {
		return cryptocontent.RotationCommitResult{}, errors.New("missing start operation")
	}
	fake.snapshot.Operation = plan.Next
	return fake.rotationCommit(), nil
}

func (fake *rotationRepositoryFake) RecordGenerated(
	_ context.Context,
	_ cryptocontent.RotationScope,
	transition cryptocontent.RotationTransition,
) (cryptocontent.RotationCommitResult, error) {
	fake.snapshot.Operation = &transition.Next
	return fake.rotationCommit(), nil
}

func (fake *rotationRepositoryFake) Promote(
	_ context.Context,
	_ cryptocontent.RotationScope,
	transition cryptocontent.RotationTransition,
) (cryptocontent.RotationCommitResult, error) {
	state, ok := transition.Next.State.(cryptocontent.RotationCompleted)
	if !ok {
		return cryptocontent.RotationCommitResult{}, errors.New("missing completed state")
	}
	fake.snapshot.Keyring = rotationKeyring(nil, transition.Next.VaultID, transition.Next.TargetVersion,
		fake.snapshot.Keyring.Versions[0], state.Metadata)
	fake.snapshot.Operation = &transition.Next
	return fake.rotationCommit(), nil
}

func (fake *rotationRepositoryFake) rotationCommit() cryptocontent.RotationCommitResult {
	snapshot := fake.snapshot
	return cryptocontent.RotationCommitResult{Kind: cryptocontent.RotationApplied, Snapshot: &snapshot}
}

type rotationKeysFake struct {
	metadata  cryptocontent.VaultDEKMetadata
	generated *cryptocontent.DataEncryptionKey
	calls     int
	fail      bool
}

func (fake *rotationKeysFake) GenerateDataKey(
	context.Context,
	identity.VaultID,
	cryptocontent.DEKVersion,
) (cryptocontent.VaultDEKMetadata, *cryptocontent.DataEncryptionKey, error) {
	fake.calls++
	if fake.fail {
		key, err := cryptocontent.NewDataEncryptionKey(make([]byte, 32))
		if err != nil {
			return cryptocontent.VaultDEKMetadata{}, nil, err
		}
		fake.generated = key
		return cryptocontent.VaultDEKMetadata{}, key, errFakeKMS
	}
	key, err := cryptocontent.NewDataEncryptionKey(make([]byte, 32))
	fake.generated = key
	return fake.metadata, key, err
}

func (*rotationKeysFake) UnwrapDataKey(
	context.Context,
	cryptocontent.VaultDEKMetadata,
) (*cryptocontent.DataEncryptionKey, error) {
	return nil, errors.New("unexpected unwrap")
}

func rotationScope(t *testing.T) cryptocontent.RotationScope {
	t.Helper()
	accountID, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	if err != nil {
		t.Fatal(err)
	}
	return cryptocontent.RotationScope{
		AccountID: accountID,
		VaultID:   rotationVaultID(t, "01991f20-61d2-7000-8000-000000000201"),
	}
}

func rotationVaultID(t *testing.T, raw string) identity.VaultID {
	t.Helper()
	value, err := identity.ParseVaultID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func rotationOperationID(t *testing.T, raw string) cryptocontent.RotationOperationID {
	t.Helper()
	value, err := cryptocontent.ParseRotationOperationID(raw)
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func rotationMetadata(vaultID identity.VaultID, version int64, createdAt int64) cryptocontent.VaultDEKMetadata {
	return cryptocontent.VaultDEKMetadata{
		VaultID: vaultID, DEKVersion: cryptocontent.DEKVersion(version),
		KEKReference: "projects/test/locations/test/keyRings/test/cryptoKeys/test/cryptoKeyVersions/1",
		WrappedDEK:   "d3JhcHBlZA", CreatedAtMilli: createdAt,
	}
}

func rotationKeyring(
	t *testing.T,
	vaultID identity.VaultID,
	writeVersion cryptocontent.DEKVersion,
	versions ...cryptocontent.VaultDEKMetadata,
) cryptocontent.VaultDEKKeyring {
	if t != nil {
		t.Helper()
	}
	keyring, err := cryptocontent.NewVaultDEKKeyring(vaultID, writeVersion, versions)
	if err != nil {
		if t == nil {
			panic(err)
		}
		t.Fatal(err)
	}
	return keyring
}
