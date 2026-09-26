package localfixture_test

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	localfixtureadapter "github.com/fukamu/notes/backend/internal/adapters/localfixture"
)

func TestPrepareLayoutCreatesOnlyPrivateFixtureDirectoriesAndIsIdempotent(t *testing.T) {
	t.Parallel()
	root := privateDirectory(t)
	first, err := localfixtureadapter.PrepareLayout(root)
	if err != nil {
		t.Fatalf("PrepareLayout() error = %v", err)
	}
	second, err := localfixtureadapter.PrepareLayout(root)
	if err != nil {
		t.Fatalf("PrepareLayout() second error = %v", err)
	}
	if first != second || first.RootDirectory != root {
		t.Fatalf("layouts differ: %#v %#v", first, second)
	}
	for _, path := range []string{first.ObjectDirectory, first.NonceDirectory, first.KeyDirectory} {
		info, err := os.Lstat(path)
		if err != nil || !info.IsDir() || info.Mode().Perm() != 0o700 || info.Mode()&os.ModeSymlink != 0 {
			t.Fatalf("fixture directory %q info = %#v, error = %v", path, info, err)
		}
	}
	opened, err := localfixtureadapter.OpenLayout(root)
	if err != nil || opened != first {
		t.Fatalf("OpenLayout() = %#v, %v", opened, err)
	}
}

func TestLayoutRejectsUnexpectedEntriesSymlinksAndUnsafePermissions(t *testing.T) {
	t.Parallel()
	t.Run("unexpected root entry", func(t *testing.T) {
		root := privateDirectory(t)
		if err := os.WriteFile(filepath.Join(root, "unrelated"), []byte("do-not-touch"), 0o600); err != nil {
			t.Fatal(err)
		}
		if _, err := localfixtureadapter.PrepareLayout(root); !errors.Is(err, localfixtureadapter.ErrLayoutOperation) {
			t.Fatalf("PrepareLayout() error = %v", err)
		}
		if value, err := os.ReadFile(filepath.Join(root, "unrelated")); err != nil || string(value) != "do-not-touch" {
			t.Fatal("layout validation modified the unexpected entry")
		}
	})
	t.Run("missing child", func(t *testing.T) {
		root := privateDirectory(t)
		if _, err := localfixtureadapter.OpenLayout(root); !errors.Is(err, localfixtureadapter.ErrLayoutOperation) {
			t.Fatalf("OpenLayout() error = %v", err)
		}
	})
	t.Run("symlink child", func(t *testing.T) {
		root := privateDirectory(t)
		target := privateDirectory(t)
		if err := os.Symlink(target, filepath.Join(root, "objects")); err != nil {
			t.Fatal(err)
		}
		if _, err := localfixtureadapter.PrepareLayout(root); !errors.Is(err, localfixtureadapter.ErrLayoutOperation) {
			t.Fatalf("PrepareLayout() error = %v", err)
		}
	})
	t.Run("unsafe child mode", func(t *testing.T) {
		root := privateDirectory(t)
		if err := os.Mkdir(filepath.Join(root, "objects"), 0o750); err != nil {
			t.Fatal(err)
		}
		if _, err := localfixtureadapter.PrepareLayout(root); !errors.Is(err, localfixtureadapter.ErrLayoutOperation) {
			t.Fatalf("PrepareLayout() error = %v", err)
		}
	})
	t.Run("unsafe root mode", func(t *testing.T) {
		root := privateDirectory(t)
		if err := os.Chmod(root, 0o750); err != nil {
			t.Fatal(err)
		}
		if _, err := localfixtureadapter.PrepareLayout(root); !errors.Is(err, localfixtureadapter.ErrLayoutOperation) {
			t.Fatalf("PrepareLayout() error = %v", err)
		}
	})
	t.Run("relative root", func(t *testing.T) {
		if _, err := localfixtureadapter.PrepareLayout("fixture"); !errors.Is(err, localfixtureadapter.ErrLayoutOperation) {
			t.Fatalf("PrepareLayout() error = %v", err)
		}
	})
}

func privateDirectory(t *testing.T) string {
	t.Helper()
	path := t.TempDir()
	if err := os.Chmod(path, 0o700); err != nil {
		t.Fatal(err)
	}
	return path
}
