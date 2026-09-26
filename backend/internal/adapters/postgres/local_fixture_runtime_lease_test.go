package postgres

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestAcquireLocalFixtureHostLockRejectsDirectorySwapDuringAcquisition(t *testing.T) {
	parent := t.TempDir()
	directory := filepath.Join(parent, "lease")
	if err := os.Mkdir(directory, 0o700); err != nil {
		t.Fatal(err)
	}
	moved := directory + ".moved"
	lock, err := acquireLocalFixtureHostLockAt(directory, func() {
		if renameErr := os.Rename(directory, moved); renameErr != nil {
			t.Fatal(renameErr)
		}
		if mkdirErr := os.Mkdir(directory, 0o700); mkdirErr != nil {
			t.Fatal(mkdirErr)
		}
	})
	if !errors.Is(err, ErrLocalFixtureRuntimeLease) || lock != nil {
		if lock != nil {
			_ = lock.close()
		}
		t.Fatalf("acquire after directory swap = %#v, %v", lock, err)
	}
}

func TestLocalFixtureHostLockDetectsPathDirectoryReplacement(t *testing.T) {
	parent := t.TempDir()
	directory := filepath.Join(parent, "lease")
	lock, err := acquireLocalFixtureHostLockAt(directory, nil)
	if err != nil {
		t.Fatal(err)
	}
	moved := directory + ".moved"
	if err := os.Rename(directory, moved); err != nil {
		_ = lock.close()
		t.Fatal(err)
	}
	if err := os.Mkdir(directory, 0o700); err != nil {
		_ = lock.close()
		t.Fatal(err)
	}
	if lock.check() {
		_ = lock.close()
		t.Fatal("check() accepted a replacement lock directory")
	}

	replacement, err := acquireLocalFixtureHostLockAt(directory, nil)
	if err != nil {
		_ = lock.close()
		t.Fatalf("replacement namespace acquisition = %v", err)
	}
	if err := replacement.close(); err != nil {
		_ = lock.close()
		t.Fatalf("replacement close = %v", err)
	}
	if err := lock.close(); err != nil {
		t.Fatalf("anchored lock close after path replacement = %v", err)
	}
}
