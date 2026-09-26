package recoverybackup_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/recoverybackup"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestDirectoryReadsOnlyExactPrivateRecoveryFiles(t *testing.T) {
	root := privateDirectory(t)
	manifest := []byte(`{"format":"fixture"}`)
	writePrivateFile(t, filepath.Join(root, "manifest.json"), manifest)
	backupID, _ := encryptedobject.ParseRecoveryBackupID("backup_a")
	backupRoot := filepath.Join(root, string(backupID))
	if err := os.Mkdir(backupRoot, 0o700); err != nil {
		t.Fatal(err)
	}
	objectKey, _ := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat("A", 43))
	writePrivateFile(t, filepath.Join(backupRoot, string(objectKey)), []byte("ciphertext"))

	directory, err := recoverybackup.NewDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	loadedManifest, err := directory.LoadManifest(context.Background(), recoveryScope(t))
	if err != nil || string(loadedManifest) != string(manifest) {
		t.Fatalf("manifest=%q err=%v", loadedManifest, err)
	}
	loadedManifest[0] = 'X'
	loaded, found, err := directory.LoadCiphertext(context.Background(), backupID, objectKey)
	if err != nil || !found || string(loaded) != "ciphertext" {
		t.Fatalf("ciphertext=%q found=%t err=%v", loaded, found, err)
	}
	missingKey, _ := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat("B", 43))
	if _, found, err := directory.LoadCiphertext(context.Background(), backupID, missingKey); err != nil || found {
		t.Fatalf("missing found=%t err=%v", found, err)
	}
}

func TestDirectoryRejectsUnsafeRootsEntriesAndCancellation(t *testing.T) {
	if _, err := recoverybackup.NewDirectory("relative"); !errors.Is(err, recoverybackup.ErrDirectoryOperation) {
		t.Fatalf("relative root error=%v", err)
	}
	root := privateDirectory(t)
	writePrivateFile(t, filepath.Join(root, "manifest.json"), []byte("{}"))
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := recoverybackup.NewDirectory(root); !errors.Is(err, recoverybackup.ErrDirectoryOperation) {
		t.Fatalf("open root error=%v", err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	directory, err := recoverybackup.NewDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := directory.LoadManifest(cancelled, recoveryScope(t)); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error=%v", err)
	}
	if err := os.Chmod(filepath.Join(root, "manifest.json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := directory.LoadManifest(context.Background(), recoveryScope(t)); !errors.Is(err, recoverybackup.ErrDirectoryOperation) {
		t.Fatalf("manifest permission error=%v", err)
	}
}

func TestDirectoryRejectsSymlinkedBackupAndCiphertext(t *testing.T) {
	root := privateDirectory(t)
	writePrivateFile(t, filepath.Join(root, "manifest.json"), []byte("{}"))
	outside := privateDirectory(t)
	backupID, _ := encryptedobject.ParseRecoveryBackupID("backup_link")
	if err := os.Symlink(outside, filepath.Join(root, string(backupID))); err != nil {
		t.Fatal(err)
	}
	directory, err := recoverybackup.NewDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	objectKey, _ := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat("C", 43))
	if _, _, err := directory.LoadCiphertext(context.Background(), backupID, objectKey); !errors.Is(err, recoverybackup.ErrDirectoryOperation) {
		t.Fatalf("symlink error=%v", err)
	}
}

func privateDirectory(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	return root
}

func writePrivateFile(t *testing.T, path string, value []byte) {
	t.Helper()
	if err := os.WriteFile(path, value, 0o600); err != nil {
		t.Fatal(err)
	}
}

func recoveryScope(t *testing.T) encryptedobject.RecoveryScope {
	t.Helper()
	accountID, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000001101")
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-000000001201")
	if err != nil {
		t.Fatal(err)
	}
	return encryptedobject.RecoveryScope{AccountID: accountID, VaultID: vaultID}
}
