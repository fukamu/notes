package objectstorage_test

import (
	"context"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

func TestMemoryIsImmutableAndReturnsCopies(t *testing.T) {
	key, _ := encryptedobject.ParseObjectKey("obj_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA")
	memory, err := objectstorage.NewMemory(nil)
	if err != nil {
		t.Fatal(err)
	}
	input := []byte{1, 2, 3}
	result, err := memory.PutIfAbsent(context.Background(), key, input, 1_000)
	if err != nil || result != encryptedobject.PutStored {
		t.Fatalf("first put = %q, %v", result, err)
	}
	input[0] = 9
	stored, found, err := memory.Get(context.Background(), key)
	if err != nil || !found || stored[0] != 1 {
		t.Fatalf("stored = %v, %t, %v", stored, found, err)
	}
	stored[0] = 8
	again, _, _ := memory.Get(context.Background(), key)
	if again[0] != 1 {
		t.Fatal("Get leaked mutable storage")
	}
	if result, _ := memory.PutIfAbsent(context.Background(), key, []byte{1, 2, 3}, 2_000); result != encryptedobject.PutAlreadyPresent {
		t.Fatalf("same put = %q", result)
	}
	if result, _ := memory.PutIfAbsent(context.Background(), key, []byte{3, 2, 1}, 2_000); result != encryptedobject.PutConflict {
		t.Fatalf("conflicting put = %q", result)
	}
}

func TestRandomObjectKeyGenerator(t *testing.T) {
	generator := objectstorage.NewRandomObjectKeyGenerator()
	first, err := generator.CreateObjectKey(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	second, err := generator.CreateObjectKey(context.Background())
	if err != nil || first == second {
		t.Fatalf("keys = %q, %q, error = %v", first, second, err)
	}
	if _, err := encryptedobject.ParseObjectKey(first); err != nil {
		t.Fatalf("invalid generated key: %v", err)
	}
}
