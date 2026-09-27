package encryptedobject_test

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/adapters/objectstorage"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

func TestOrphanCollectorBoundsAndResumesWithoutDuplicateOutboxRows(t *testing.T) {
	keys := []encryptedobject.ObjectKey{
		mustObjectKey(t, "obj_v1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
		mustObjectKey(t, "obj_v1_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"),
		mustObjectKey(t, "obj_v1_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC"),
		mustObjectKey(t, "obj_v1_DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD"),
		mustObjectKey(t, "obj_v1_EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEE"),
	}
	objects, err := objectstorage.NewMemory([]objectstorage.Seed{
		{ObjectKey: keys[0], Bytes: []byte{1}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[1], Bytes: []byte{1}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[2], Bytes: []byte{1}, CreatedAtMilli: 1_000},
		{ObjectKey: keys[3], Bytes: []byte{1}, CreatedAtMilli: 9_000},
		{ObjectKey: keys[4], Bytes: []byte{1}, CreatedAtMilli: 9_001},
	})
	if err != nil {
		t.Fatal(err)
	}
	repository := newMemoryRepository()
	repository.outbox[keys[0]] = encryptedobject.DeleteOutboxEntry{
		ObjectKey: keys[0], NextAttemptAt: 1_000, CreatedAtMilli: 1_000,
	}
	collector, err := encryptedobject.NewOrphanCollector(repository, objects)
	if err != nil {
		t.Fatal(err)
	}

	first, err := collector.CollectBatch(context.Background(), 10_000, 1_000, 2)
	if err != nil || first != (encryptedobject.OrphanCollectionBatchResult{Enqueued: 2, Pending: true}) {
		t.Fatalf("first batch = %#v, %v", first, err)
	}
	if len(repository.outbox) != 3 {
		t.Fatalf("first outbox count = %d", len(repository.outbox))
	}
	second, err := collector.CollectBatch(context.Background(), 10_000, 1_000, 2)
	if err != nil || second != (encryptedobject.OrphanCollectionBatchResult{Enqueued: 1}) {
		t.Fatalf("second batch = %#v, %v", second, err)
	}
	third, err := collector.CollectBatch(context.Background(), 10_000, 1_000, 2)
	if err != nil || third != (encryptedobject.OrphanCollectionBatchResult{}) || len(repository.outbox) != 4 {
		t.Fatalf("replay batch = %#v, %v, outbox=%d", third, err, len(repository.outbox))
	}
}

func TestOrphanCollectorRejectsInvalidInputAndPropagatesInventoryFailure(t *testing.T) {
	objects, _ := objectstorage.NewMemory(nil)
	repository := newMemoryRepository()
	if _, err := encryptedobject.NewOrphanCollector(nil, objects); !errors.Is(err, encryptedobject.ErrInvalidOperation) {
		t.Fatalf("nil repository error = %v", err)
	}
	collector, _ := encryptedobject.NewOrphanCollector(repository, objects)
	for _, input := range []struct {
		scan, grace int64
		limit       int
	}{{0, 0, 1}, {1, -1, 1}, {1, 0, 0}, {1, 0, 101}} {
		if _, err := collector.CollectBatch(context.Background(), input.scan, input.grace, input.limit); !errors.Is(err, encryptedobject.ErrInvalidOperation) {
			t.Fatalf("input %#v error = %v", input, err)
		}
	}
	objects.FailNext(objectstorage.OperationList)
	if _, err := collector.CollectBatch(context.Background(), 10_000, 1_000, 1); err == nil {
		t.Fatal("inventory failure was accepted")
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := collector.CollectBatch(cancelled, 10_000, 1_000, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error = %v", err)
	}
}
