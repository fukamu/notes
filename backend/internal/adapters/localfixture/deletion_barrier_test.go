package localfixture

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	recoverykeyadapter "github.com/fukamu/notes/backend/internal/adapters/recoverykey"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	fixture "github.com/fukamu/notes/backend/internal/localfixture"
)

func TestDeletionBarrierRequiresRealObjectEmptinessAndDestroysExactKeyMaterial(t *testing.T) {
	layout := deletionLayout(t)
	scope := deletionScope(t)
	metadata, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, scope.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	nonce := filepath.Join(layout.NonceDirectory, "nonce_v1_"+strings.Repeat("a", 64))
	if err := os.WriteFile(nonce, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	object := filepath.Join(layout.ObjectDirectory, "obj_v1_"+strings.Repeat("A", 43))
	if err := os.WriteFile(object, []byte("ciphertext"), 0o600); err != nil {
		t.Fatal(err)
	}
	delegate := &finalizationGateStub{databaseKey: &metadata}
	barrier, err := NewDeletionBarrier(scope, layout, delegate)
	if err != nil {
		t.Fatal(err)
	}
	command := deletionFinalizationCommand(t, scope)
	result, err := barrier.Evaluate(context.Background(), command)
	if err != nil || result.Reason != accountdeletion.AccountFinalizationPrivateObjectsRemaining {
		t.Fatalf("Evaluate() = %#v, %v", result, err)
	}
	if err := os.Remove(object); err != nil {
		t.Fatal(err)
	}
	result, err = barrier.FinalizeWrappedKeys(
		context.Background(), command,
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	)
	if err != nil || result.Kind != accountdeletion.AccountFinalizationConfirmed {
		t.Fatalf("FinalizeWrappedKeys() = %#v, %v", result, err)
	}
	for _, directory := range []string{layout.KeyDirectory, layout.NonceDirectory} {
		entries, readErr := os.ReadDir(directory)
		if readErr != nil || len(entries) != 0 {
			t.Fatalf("directory %s entries = %v, %v", directory, entries, readErr)
		}
	}
	result, err = barrier.FinalizeLiveState(
		context.Background(), command,
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	)
	if err != nil || result.Kind != accountdeletion.AccountFinalizationConfirmed || delegate.liveCalls != 1 {
		t.Fatalf("FinalizeLiveState() = %#v, %v; calls=%d", result, err, delegate.liveCalls)
	}
}

func TestDeletionBarrierNeverDeletesUnknownOrOutsideFiles(t *testing.T) {
	layout := deletionLayout(t)
	scope := deletionScope(t)
	metadata, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, scope.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "keep")
	if err := os.WriteFile(outside, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	unknown := filepath.Join(layout.NonceDirectory, "not-a-fixture-nonce")
	if err := os.WriteFile(unknown, []byte("keep"), 0o600); err != nil {
		t.Fatal(err)
	}
	delegate := &finalizationGateStub{databaseKey: &metadata}
	barrier, err := NewDeletionBarrier(scope, layout, delegate)
	if err != nil {
		t.Fatal(err)
	}
	result, err := barrier.FinalizeWrappedKeys(
		context.Background(), deletionFinalizationCommand(t, scope),
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	)
	if err != nil || result.Reason != accountdeletion.AccountFinalizationWrappedKeysRemaining {
		t.Fatalf("FinalizeWrappedKeys() = %#v, %v", result, err)
	}
	if delegate.wrappedCalls != 0 {
		t.Fatalf("database finalization ran before complete filesystem validation: %d", delegate.wrappedCalls)
	}
	if _, statErr := os.Stat(filepath.Join(layout.KeyDirectory, "dek-1.json")); statErr != nil {
		t.Fatalf("valid key was removed before unknown nonce refusal: %v", statErr)
	}
	for _, path := range []string{outside, unknown} {
		if _, statErr := os.Stat(path); statErr != nil {
			t.Fatalf("file %s was removed: %v", path, statErr)
		}
	}
}

func TestDeletionBarrierRequiresEmptyPrivateNonceAndExactDirectoryMode(t *testing.T) {
	layout := deletionLayout(t)
	scope := deletionScope(t)
	metadata, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, scope.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	nonce := filepath.Join(layout.NonceDirectory, "nonce_v1_"+strings.Repeat("c", 64))
	if err := os.WriteFile(nonce, []byte("not-empty"), 0o600); err != nil {
		t.Fatal(err)
	}
	delegate := &finalizationGateStub{databaseKey: &metadata}
	barrier, err := NewDeletionBarrier(scope, layout, delegate)
	if err != nil {
		t.Fatal(err)
	}
	result, err := barrier.FinalizeWrappedKeys(
		context.Background(), deletionFinalizationCommand(t, scope),
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	)
	if err != nil || result.Reason != accountdeletion.AccountFinalizationWrappedKeysRemaining || delegate.wrappedCalls != 0 {
		t.Fatalf("non-empty nonce result = %#v, %v; calls=%d", result, err, delegate.wrappedCalls)
	}
	if err := os.WriteFile(nonce, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(layout.NonceDirectory, 0o750); err != nil {
		t.Fatal(err)
	}
	if _, err := barrier.FinalizeWrappedKeys(
		context.Background(), deletionFinalizationCommand(t, scope),
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	); err == nil {
		t.Fatal("non-private directory mode was accepted")
	}
	if delegate.wrappedCalls != 0 {
		t.Fatalf("delegate calls after directory mode change = %d", delegate.wrappedCalls)
	}
}

func TestCheckDeletionInventoryRequiresExactTrackedPrivateFiles(t *testing.T) {
	layout := deletionLayout(t)
	scope := deletionScope(t)
	metadata, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, scope.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	key := "obj_v1_" + strings.Repeat("B", 43)
	if err := os.WriteFile(filepath.Join(layout.ObjectDirectory, key), []byte("ciphertext"), 0o600); err != nil {
		t.Fatal(err)
	}
	parsed, _ := encryptedobject.ParseObjectKey(key)
	if err := CheckDeletionInventory(context.Background(), layout, scope.VaultID, DeletionKeyInventory{
		DatabaseMetadata: &metadata,
	}, []encryptedobject.ObjectKey{parsed}); err != nil {
		t.Fatalf("tracked inventory = %v", err)
	}
	if err := CheckDeletionInventory(context.Background(), layout, scope.VaultID, DeletionKeyInventory{
		AllowResidualFile: true,
	}, []encryptedobject.ObjectKey{parsed}); err != nil {
		t.Fatalf("deleting residual key inventory = %v", err)
	}
	if err := CheckDeletionInventory(context.Background(), layout, scope.VaultID, DeletionKeyInventory{
		ForbidFile: true,
	}, []encryptedobject.ObjectKey{parsed}); err == nil {
		t.Fatal("completed inventory accepted a residual key")
	}
	mismatch := metadata
	mismatch.CreatedAtMilli++
	if err := CheckDeletionInventory(context.Background(), layout, scope.VaultID, DeletionKeyInventory{
		DatabaseMetadata: &mismatch,
	}, []encryptedobject.ObjectKey{parsed}); err == nil {
		t.Fatal("database/file key metadata mismatch was accepted")
	}
	if err := os.WriteFile(filepath.Join(layout.ObjectDirectory, ".put-untracked"), nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CheckDeletionInventory(context.Background(), layout, scope.VaultID, DeletionKeyInventory{
		DatabaseMetadata: &metadata,
	}, []encryptedobject.ObjectKey{parsed}); err == nil {
		t.Fatal("untracked temporary object was accepted")
	}
	if err := os.Remove(filepath.Join(layout.ObjectDirectory, ".put-untracked")); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(filepath.Join(layout.KeyDirectory, "dek-1.json")); err != nil {
		t.Fatal(err)
	}
	if err := CheckDeletionInventory(context.Background(), layout, scope.VaultID, DeletionKeyInventory{
		AllowResidualFile: true,
	}, []encryptedobject.ObjectKey{parsed}); err != nil {
		t.Fatalf("deleting inventory without key = %v", err)
	}
	if err := CheckDeletionInventory(context.Background(), layout, scope.VaultID, DeletionKeyInventory{
		DatabaseMetadata: &metadata,
	}, []encryptedobject.ObjectKey{parsed}); err == nil {
		t.Fatal("pristine inventory without key was accepted")
	}
	if err := CheckDeletionInventory(context.Background(), layout, scope.VaultID, DeletionKeyInventory{
		ForbidFile: true,
	}, []encryptedobject.ObjectKey{parsed}); err != nil {
		t.Fatalf("completed inventory without key = %v", err)
	}
}

func TestCheckDeletionInventoryRequiresEmptyNonceFilesAndNoCompletedResiduals(t *testing.T) {
	layout := deletionLayout(t)
	scope := deletionScope(t)
	nonce := filepath.Join(layout.NonceDirectory, "nonce_v1_"+strings.Repeat("d", 64))
	if err := os.WriteFile(nonce, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CheckDeletionInventory(
		context.Background(), layout, scope.VaultID,
		DeletionKeyInventory{AllowResidualFile: true}, nil,
	); err != nil {
		t.Fatalf("deleting nonce inventory = %v", err)
	}
	if err := CheckDeletionInventory(
		context.Background(), layout, scope.VaultID,
		DeletionKeyInventory{ForbidFile: true, ForbidObjectFiles: true, ForbidNonceFiles: true}, nil,
	); err == nil {
		t.Fatal("completed inventory accepted a residual nonce")
	}
	if err := os.WriteFile(nonce, []byte{1}, 0o600); err != nil {
		t.Fatal(err)
	}
	if err := CheckDeletionInventory(
		context.Background(), layout, scope.VaultID,
		DeletionKeyInventory{AllowResidualFile: true}, nil,
	); err == nil {
		t.Fatal("non-empty nonce reservation was accepted")
	}
	if err := os.Remove(nonce); err != nil {
		t.Fatal(err)
	}
	if err := CheckDeletionInventory(
		context.Background(), layout, scope.VaultID,
		DeletionKeyInventory{ForbidFile: true, ForbidObjectFiles: true, ForbidNonceFiles: true}, nil,
	); err != nil {
		t.Fatalf("empty completed inventory = %v", err)
	}
}

func TestDeletionBarrierCleansResidualKeyAfterDatabaseReplay(t *testing.T) {
	layout := deletionLayout(t)
	scope := deletionScope(t)
	if _, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, scope.VaultID); err != nil {
		t.Fatal(err)
	}
	delegate := &finalizationGateStub{}
	barrier, err := NewDeletionBarrier(scope, layout, delegate)
	if err != nil {
		t.Fatal(err)
	}
	result, err := barrier.FinalizeWrappedKeys(
		context.Background(), deletionFinalizationCommand(t, scope),
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	)
	if err != nil || result.Kind != accountdeletion.AccountFinalizationConfirmed || delegate.wrappedCalls != 1 {
		t.Fatalf("FinalizeWrappedKeys() = %#v, %v; calls=%d", result, err, delegate.wrappedCalls)
	}
	if _, err := os.Lstat(filepath.Join(layout.KeyDirectory, "dek-1.json")); !os.IsNotExist(err) {
		t.Fatalf("residual key still exists: %v", err)
	}
}

func TestDeletionBarrierRecoversQuarantinedKeyAndNonceAfterRestart(t *testing.T) {
	layout := deletionLayout(t)
	scope := deletionScope(t)
	if _, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, scope.VaultID); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(
		filepath.Join(layout.KeyDirectory, fixtureKeyName),
		filepath.Join(layout.KeyDirectory, fixtureKeyQuarantineName),
	); err != nil {
		t.Fatal(err)
	}
	nonceName := "nonce_v1_" + strings.Repeat("e", 64)
	if err := os.WriteFile(
		filepath.Join(layout.NonceDirectory, nonceDeleteQuarantinePrefix+nonceName), nil, 0o600,
	); err != nil {
		t.Fatal(err)
	}
	if err := CheckDeletionInventory(
		context.Background(), layout, scope.VaultID,
		DeletionKeyInventory{AllowResidualFile: true, AllowNonceQuarantine: true}, nil,
	); err != nil {
		t.Fatalf("restart inventory = %v", err)
	}
	delegate := &finalizationGateStub{}
	barrier, err := NewDeletionBarrier(scope, layout, delegate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = barrier.Close() })
	result, err := barrier.FinalizeWrappedKeys(
		context.Background(), deletionFinalizationCommand(t, scope),
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	)
	if err != nil || result.Kind != accountdeletion.AccountFinalizationConfirmed || delegate.wrappedCalls != 1 {
		t.Fatalf("FinalizeWrappedKeys() = %#v, %v; calls=%d", result, err, delegate.wrappedCalls)
	}
	for _, directory := range []string{layout.KeyDirectory, layout.NonceDirectory} {
		entries, readErr := os.ReadDir(directory)
		if readErr != nil || len(entries) != 0 {
			t.Fatalf("directory %s entries = %v, %v", directory, entries, readErr)
		}
	}
}

func TestDeletionBarrierRejectsDatabaseKeyWithoutFileAndMetadataMismatch(t *testing.T) {
	layout := deletionLayout(t)
	scope := deletionScope(t)
	metadata, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, scope.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	delegate := &finalizationGateStub{databaseKey: &metadata}
	barrier, err := NewDeletionBarrier(scope, layout, delegate)
	if err != nil {
		t.Fatal(err)
	}
	keyPath := filepath.Join(layout.KeyDirectory, "dek-1.json")
	if err := os.Remove(keyPath); err != nil {
		t.Fatal(err)
	}
	result, err := barrier.FinalizeWrappedKeys(
		context.Background(), deletionFinalizationCommand(t, scope),
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	)
	if err != nil || result.Reason != accountdeletion.AccountFinalizationWrappedKeysRemaining || delegate.wrappedCalls != 0 {
		t.Fatalf("missing key result = %#v, %v; calls=%d", result, err, delegate.wrappedCalls)
	}
	if _, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, scope.VaultID); err != nil {
		t.Fatal(err)
	}
	mismatch := metadata
	mismatch.CreatedAtMilli++
	delegate.databaseKey = &mismatch
	result, err = barrier.FinalizeWrappedKeys(
		context.Background(), deletionFinalizationCommand(t, scope),
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	)
	if err != nil || result.Reason != accountdeletion.AccountFinalizationWrappedKeysRemaining || delegate.wrappedCalls != 0 {
		t.Fatalf("mismatched key result = %#v, %v; calls=%d", result, err, delegate.wrappedCalls)
	}
}

func TestDeletionBarrierRejectsChildDirectorySwapBeforeMutation(t *testing.T) {
	layout := deletionLayout(t)
	scope := deletionScope(t)
	metadata, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, scope.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	delegate := &finalizationGateStub{databaseKey: &metadata}
	barrier, err := NewDeletionBarrier(scope, layout, delegate)
	if err != nil {
		t.Fatal(err)
	}
	moved := filepath.Join(t.TempDir(), "moved-keys")
	if err := os.Rename(layout.KeyDirectory, moved); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(moved, layout.KeyDirectory); err != nil {
		t.Fatal(err)
	}
	if _, err := barrier.FinalizeWrappedKeys(
		context.Background(), deletionFinalizationCommand(t, scope),
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	); err == nil {
		t.Fatal("child-directory symlink swap was accepted")
	}
	if delegate.wrappedCalls != 0 {
		t.Fatalf("delegate calls after directory swap = %d", delegate.wrappedCalls)
	}
	if _, err := os.Lstat(filepath.Join(moved, "dek-1.json")); err != nil {
		t.Fatalf("outside key was changed: %v", err)
	}
}

func TestDeletionBarrierRejectsRootNameSwapBeforeMutation(t *testing.T) {
	layout := deletionLayout(t)
	scope := deletionScope(t)
	metadata, err := recoverykeyadapter.PrepareFixtureKey(layout.KeyDirectory, scope.VaultID)
	if err != nil {
		t.Fatal(err)
	}
	delegate := &finalizationGateStub{databaseKey: &metadata}
	barrier, err := NewDeletionBarrier(scope, layout, delegate)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = barrier.Close() })
	moved := layout.RootDirectory + "-moved"
	if err := os.Rename(layout.RootDirectory, moved); err != nil {
		t.Fatal(err)
	}
	outside := deletionLayout(t)
	if _, err := recoverykeyadapter.PrepareFixtureKey(outside.KeyDirectory, scope.VaultID); err != nil {
		t.Fatalf("prepare outside key = %v", err)
	}
	if err := os.Symlink(outside.RootDirectory, layout.RootDirectory); err != nil {
		t.Fatal(err)
	}
	if _, err := barrier.FinalizeWrappedKeys(
		context.Background(), deletionFinalizationCommand(t, scope),
		accountdeletion.LegalEvidenceFinalizationPolicy{Kind: accountdeletion.LegalEvidenceDeleteLive},
	); err == nil {
		t.Fatal("root-name symlink swap was accepted")
	}
	if delegate.wrappedCalls != 0 {
		t.Fatalf("delegate calls after root swap = %d", delegate.wrappedCalls)
	}
	for _, path := range []string{
		filepath.Join(moved, fixture.KeyDirectoryName, fixtureKeyName),
		filepath.Join(outside.KeyDirectory, fixtureKeyName),
	} {
		if _, err := os.Lstat(path); err != nil {
			t.Fatalf("key %s was changed: %v", path, err)
		}
	}
}

type finalizationGateStub struct {
	liveCalls    int
	wrappedCalls int
	databaseKey  *cryptocontent.VaultDEKMetadata
}

func (stub *finalizationGateStub) Evaluate(context.Context, accountdeletion.AccountFinalizationCommand) (accountdeletion.AccountFinalizationResult, error) {
	return accountdeletion.AccountFinalizationResult{Kind: accountdeletion.AccountFinalizationConfirmed, Outcome: accountdeletion.AccountFinalizationReady}, nil
}

func (stub *finalizationGateStub) EvaluateLegalEvidence(context.Context, accountdeletion.AccountFinalizationCommand, accountdeletion.LegalEvidenceFinalizationPolicy) (accountdeletion.AccountFinalizationResult, error) {
	return accountdeletion.AccountFinalizationResult{Kind: accountdeletion.AccountFinalizationConfirmed, Outcome: accountdeletion.AccountFinalizationReady}, nil
}

func (stub *finalizationGateStub) FinalizeWrappedKeys(context.Context, accountdeletion.AccountFinalizationCommand, accountdeletion.LegalEvidenceFinalizationPolicy) (accountdeletion.AccountFinalizationResult, error) {
	stub.wrappedCalls++
	return accountdeletion.AccountFinalizationResult{Kind: accountdeletion.AccountFinalizationConfirmed, Outcome: accountdeletion.AccountFinalizationReady}, nil
}

func (stub *finalizationGateStub) FinalizeLiveState(context.Context, accountdeletion.AccountFinalizationCommand, accountdeletion.LegalEvidenceFinalizationPolicy) (accountdeletion.AccountFinalizationResult, error) {
	stub.liveCalls++
	return accountdeletion.AccountFinalizationResult{Kind: accountdeletion.AccountFinalizationConfirmed, Outcome: accountdeletion.AccountFinalizationDeleted}, nil
}

func (stub *finalizationGateStub) FixtureWrappedKeyMetadata(context.Context, accountdeletion.Scope) (*cryptocontent.VaultDEKMetadata, error) {
	if stub.databaseKey == nil {
		return nil, nil
	}
	copy := *stub.databaseKey
	return &copy, nil
}

func deletionLayout(t *testing.T) Layout {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	layout, err := PrepareLayout(root)
	if err != nil {
		t.Fatal(err)
	}
	return layout
}

func deletionScope(t *testing.T) accountdeletion.Scope {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01999c20-9e33-7000-8000-000000000001")
	vaultID, _ := identity.ParseVaultID("01999c20-9e33-7000-8000-000000000002")
	return accountdeletion.Scope{AccountID: accountID, VaultID: vaultID}
}

func deletionFinalizationCommand(t *testing.T, scope accountdeletion.Scope) accountdeletion.AccountFinalizationCommand {
	t.Helper()
	operationID, err := accountdeletion.ParseOperationID("01999c20-9e33-7000-8000-000000000003")
	if err != nil {
		t.Fatal(err)
	}
	return accountdeletion.AccountFinalizationCommand{
		Scope: scope, OperationID: operationID, PreviousReceiptAt: 1, AttemptedAt: 2,
	}
}
