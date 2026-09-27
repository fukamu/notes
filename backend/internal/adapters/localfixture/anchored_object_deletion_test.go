package localfixture

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

func TestAnchoredObjectDeletionRejectsDirectorySwapWithoutTouchingOutside(t *testing.T) {
	layout := deletionLayout(t)
	key, _ := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat("E", 43))
	fixturePath := filepath.Join(layout.ObjectDirectory, string(key))
	if err := os.WriteFile(fixturePath, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	deletion, err := NewAnchoredObjectDeletion(layout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deletion.Close() })
	moved := filepath.Join(t.TempDir(), "original-objects")
	if err := os.Rename(layout.ObjectDirectory, moved); err != nil {
		t.Fatal(err)
	}
	outside := t.TempDir()
	outsidePath := filepath.Join(outside, string(key))
	if err := os.WriteFile(outsidePath, []byte("outside"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(outside, layout.ObjectDirectory); err != nil {
		t.Fatal(err)
	}
	if _, err := deletion.Delete(context.Background(), key); err == nil {
		t.Fatal("directory swap was accepted")
	}
	for path, content := range map[string]string{
		filepath.Join(moved, string(key)): "fixture",
		outsidePath:                       "outside",
	} {
		actual, err := os.ReadFile(path)
		if err != nil || string(actual) != content {
			t.Fatalf("file %s = %q, %v", path, actual, err)
		}
	}
}

func TestAnchoredObjectDeletionRecoversValidatedQuarantine(t *testing.T) {
	layout := deletionLayout(t)
	key, _ := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat("F", 43))
	quarantine := filepath.Join(layout.ObjectDirectory, objectDeleteQuarantinePrefix+string(key))
	if err := os.WriteFile(quarantine, []byte("fixture"), 0o600); err != nil {
		t.Fatal(err)
	}
	deletion, err := NewAnchoredObjectDeletion(layout)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = deletion.Close() })
	result, err := deletion.Delete(context.Background(), key)
	if err != nil || result != encryptedobject.DeleteDeleted {
		t.Fatalf("Delete() = %q, %v", result, err)
	}
	entries, err := os.ReadDir(layout.ObjectDirectory)
	if err != nil || len(entries) != 0 {
		t.Fatalf("object entries = %v, %v", entries, err)
	}
}
