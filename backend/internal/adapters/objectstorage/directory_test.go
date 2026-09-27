package objectstorage_test

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

func TestDirectoryPersistsImmutableObjectsAcrossAdapterRestart(t *testing.T) {
	root := secureObjectDirectory(t)
	storage, err := objectstorage.NewDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	key := directoryObjectKey(t, 'A')
	value := []byte("encrypted-envelope")
	stored, err := storage.PutIfAbsent(context.Background(), key, value, 1_234)
	if err != nil || stored != encryptedobject.PutStored {
		t.Fatalf("stored = %q, error = %v", stored, err)
	}
	value[0] = 'X'

	restarted, err := objectstorage.NewDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	loaded, found, err := restarted.Get(context.Background(), key)
	if err != nil || !found || string(loaded) != "encrypted-envelope" {
		t.Fatalf("loaded = %q, found = %t, error = %v", loaded, found, err)
	}
	loaded[0] = 'X'
	loadedAgain, _, _ := restarted.Get(context.Background(), key)
	if string(loadedAgain) != "encrypted-envelope" {
		t.Fatalf("caller mutated stored bytes: %q", loadedAgain)
	}
	if duplicate, err := restarted.PutIfAbsent(
		context.Background(), key, []byte("encrypted-envelope"), 1_234,
	); err != nil || duplicate != encryptedobject.PutAlreadyPresent {
		t.Fatalf("duplicate = %q, error = %v", duplicate, err)
	}
	if conflict, err := restarted.PutIfAbsent(
		context.Background(), key, []byte("different-envelope"), 1_234,
	); err != nil || conflict != encryptedobject.PutConflict {
		t.Fatalf("conflict = %q, error = %v", conflict, err)
	}
	descriptors, err := restarted.List(context.Background())
	if err != nil || len(descriptors) != 1 || descriptors[0].ObjectKey != key ||
		descriptors[0].CreatedAtMilli != 1_234 {
		t.Fatalf("descriptors = %#v, error = %v", descriptors, err)
	}
	deleted, err := restarted.Delete(context.Background(), key)
	if err != nil || deleted != encryptedobject.DeleteDeleted {
		t.Fatalf("deleted = %q, error = %v", deleted, err)
	}
	if deleted, err := restarted.Delete(context.Background(), key); err != nil ||
		deleted != encryptedobject.DeleteNotFound {
		t.Fatalf("second delete = %q, error = %v", deleted, err)
	}
}

func TestDirectoryConcurrentPutHasOneImmutableWinner(t *testing.T) {
	storage, err := objectstorage.NewDirectory(secureObjectDirectory(t))
	if err != nil {
		t.Fatal(err)
	}
	key := directoryObjectKey(t, 'B')
	values := [][]byte{[]byte("first"), []byte("second")}
	results := make(chan encryptedobject.PutResult, len(values))
	errorsFound := make(chan error, len(values))
	var group sync.WaitGroup
	for _, value := range values {
		value := value
		group.Add(1)
		go func() {
			defer group.Done()
			result, putErr := storage.PutIfAbsent(context.Background(), key, value, 2_000)
			results <- result
			errorsFound <- putErr
		}()
	}
	group.Wait()
	close(results)
	close(errorsFound)
	for err := range errorsFound {
		if err != nil {
			t.Fatal(err)
		}
	}
	stored, conflicts := 0, 0
	for result := range results {
		switch result {
		case encryptedobject.PutStored:
			stored++
		case encryptedobject.PutConflict:
			conflicts++
		default:
			t.Fatalf("unexpected result %q", result)
		}
	}
	if stored != 1 || conflicts != 1 {
		t.Fatalf("stored=%d conflicts=%d", stored, conflicts)
	}
}

func TestDirectoryRejectsUnsafeRootsEntriesAndCancellation(t *testing.T) {
	if _, err := objectstorage.NewDirectory("relative"); !errors.Is(err, objectstorage.ErrDirectoryOperation) {
		t.Fatalf("relative root error = %v", err)
	}
	root := secureObjectDirectory(t)
	if err := os.Chmod(root, 0o755); err != nil {
		t.Fatal(err)
	}
	if _, err := objectstorage.NewDirectory(root); !errors.Is(err, objectstorage.ErrDirectoryOperation) {
		t.Fatalf("open-permission root error = %v", err)
	}
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	storage, err := objectstorage.NewDirectory(root)
	if err != nil {
		t.Fatal(err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := storage.PutIfAbsent(cancelled, directoryObjectKey(t, 'C'), []byte("value"), 3_000); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error = %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "unexpected"), []byte("private"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := storage.List(context.Background()); !errors.Is(err, objectstorage.ErrDirectoryOperation) {
		t.Fatalf("unexpected entry error = %v", err)
	}
}

func secureObjectDirectory(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	if err := os.Chmod(root, 0o700); err != nil {
		t.Fatal(err)
	}
	return root
}

func directoryObjectKey(t *testing.T, fill byte) encryptedobject.ObjectKey {
	t.Helper()
	value := "obj_v1_" + string(make([]byte, 43))
	bytes := []byte(value)
	for index := len("obj_v1_"); index < len(bytes); index++ {
		bytes[index] = fill
	}
	key, err := encryptedobject.ParseObjectKey(string(bytes))
	if err != nil {
		t.Fatal(err)
	}
	return key
}
