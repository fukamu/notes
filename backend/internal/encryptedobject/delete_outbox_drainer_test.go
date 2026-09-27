package encryptedobject_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestDeleteOutboxDrainerClassifiesCompletionRetryReplayAndContention(t *testing.T) {
	keys := []encryptedobject.ObjectKey{
		deleteOutboxKey(t, 'A'), deleteOutboxKey(t, 'B'),
		deleteOutboxKey(t, 'C'), deleteOutboxKey(t, 'D'),
	}
	repository := &deleteOutboxRepositoryStub{
		entries: []encryptedobject.DeleteOutboxEntry{
			deleteOutboxEntry(keys[0], 0, 1_000), deleteOutboxEntry(keys[1], 0, 1_000),
			deleteOutboxEntry(keys[2], 0, 1_000), deleteOutboxEntry(keys[3], 0, 1_000),
		},
		pending: 2,
		confirm: map[encryptedobject.ObjectKey]encryptedobject.DeleteOutboxMutationResult{
			keys[1]: {Kind: encryptedobject.DeleteOutboxMutationReplayed},
			keys[3]: {Kind: encryptedobject.DeleteOutboxMutationConflict},
		},
	}
	objects := &deleteOutboxObjectStub{behaviors: map[encryptedobject.ObjectKey]deleteOutboxBehavior{
		keys[0]: {result: encryptedobject.DeleteDeleted},
		keys[1]: {result: encryptedobject.DeleteNotFound},
		keys[2]: {err: errors.New("storage unavailable")},
		keys[3]: {result: encryptedobject.DeleteDeleted},
	}}
	drainer, err := encryptedobject.NewDeleteOutboxDrainer(repository, objects)
	if err != nil {
		t.Fatal(err)
	}

	result, err := drainer.DrainBatch(context.Background(), 2_000, 500, 4)
	want := encryptedobject.DeleteOutboxDrainBatchResult{
		Completed: 1, Retried: 1, Replayed: 1, Contended: 1, Pending: true,
	}
	if err != nil || result != want {
		t.Fatalf("DrainBatch() = %#v, %v; want %#v", result, err, want)
	}
	if repository.listLimit != 4 || repository.listAt != 2_000 || objects.calls != 4 ||
		len(repository.rescheduled) != 1 || repository.rescheduled[0].ObjectKey != keys[2] ||
		repository.rescheduled[0].AttemptCount != 1 || repository.rescheduled[0].NextAttemptAt != 2_500 {
		t.Fatalf("repository=%#v objects=%#v", repository, objects)
	}
}

func TestDeleteOutboxDrainerRejectsMalformedDependenciesBeforeUnsafeMutation(t *testing.T) {
	key := deleteOutboxKey(t, 'E')
	valid := deleteOutboxEntry(key, 0, 1_000)
	tests := []struct {
		name       string
		repository *deleteOutboxRepositoryStub
		objects    *deleteOutboxObjectStub
	}{
		{
			name: "oversized batch",
			repository: &deleteOutboxRepositoryStub{
				entries: []encryptedobject.DeleteOutboxEntry{valid, valid},
			},
			objects: &deleteOutboxObjectStub{},
		},
		{
			name: "future entry",
			repository: &deleteOutboxRepositoryStub{
				entries: []encryptedobject.DeleteOutboxEntry{deleteOutboxEntry(key, 0, 2_001)},
			},
			objects: &deleteOutboxObjectStub{},
		},
		{
			name: "unknown storage result",
			repository: &deleteOutboxRepositoryStub{
				entries: []encryptedobject.DeleteOutboxEntry{valid},
			},
			objects: &deleteOutboxObjectStub{behaviors: map[encryptedobject.ObjectKey]deleteOutboxBehavior{
				key: {result: encryptedobject.DeleteResult("unknown")},
			}},
		},
		{
			name: "unknown mutation result",
			repository: &deleteOutboxRepositoryStub{
				entries: []encryptedobject.DeleteOutboxEntry{valid},
				confirm: map[encryptedobject.ObjectKey]encryptedobject.DeleteOutboxMutationResult{
					key: {},
				},
			},
			objects: &deleteOutboxObjectStub{behaviors: map[encryptedobject.ObjectKey]deleteOutboxBehavior{
				key: {result: encryptedobject.DeleteDeleted},
			}},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			drainer, err := encryptedobject.NewDeleteOutboxDrainer(test.repository, test.objects)
			if err != nil {
				t.Fatal(err)
			}
			if _, err := drainer.DrainBatch(context.Background(), 2_000, 500, 1); !errors.Is(err, encryptedobject.ErrInvalidOperation) {
				t.Fatalf("error = %v", err)
			}
			if (test.name == "oversized batch" || test.name == "future entry") && test.objects.calls != 0 {
				t.Fatalf("unsafe delete calls = %d", test.objects.calls)
			}
		})
	}

	overflow := deleteOutboxEntry(key, encryptedobject.MaximumDeleteAttempt, 1_000)
	repository := &deleteOutboxRepositoryStub{entries: []encryptedobject.DeleteOutboxEntry{overflow}}
	objects := &deleteOutboxObjectStub{behaviors: map[encryptedobject.ObjectKey]deleteOutboxBehavior{
		key: {err: errors.New("storage unavailable")},
	}}
	drainer, _ := encryptedobject.NewDeleteOutboxDrainer(repository, objects)
	if _, err := drainer.DrainBatch(context.Background(), 2_000, 500, 1); !errors.Is(err, encryptedobject.ErrInvalidOperation) || repository.rescheduleCalls != 0 {
		t.Fatalf("overflow error=%v reschedules=%d", err, repository.rescheduleCalls)
	}
}

func TestDeleteOutboxDrainerHonorsCancellationWithoutConfirming(t *testing.T) {
	key := deleteOutboxKey(t, 'F')
	repository := &deleteOutboxRepositoryStub{entries: []encryptedobject.DeleteOutboxEntry{
		deleteOutboxEntry(key, 0, 1_000),
	}}
	ctx, cancel := context.WithCancel(context.Background())
	objects := &deleteOutboxObjectStub{
		behaviors: map[encryptedobject.ObjectKey]deleteOutboxBehavior{
			key: {result: encryptedobject.DeleteDeleted},
		},
		afterDelete: cancel,
	}
	drainer, _ := encryptedobject.NewDeleteOutboxDrainer(repository, objects)
	if _, err := drainer.DrainBatch(ctx, 2_000, 500, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancellation error = %v", err)
	}
	if repository.confirmCalls != 0 || repository.rescheduleCalls != 0 || repository.countCalls != 0 {
		t.Fatalf("repository mutated after cancellation: %#v", repository)
	}
}

func TestDeleteOutboxDrainerValidatesConfiguration(t *testing.T) {
	repository := &deleteOutboxRepositoryStub{}
	objects := &deleteOutboxObjectStub{}
	if _, err := encryptedobject.NewDeleteOutboxDrainer(nil, objects); !errors.Is(err, encryptedobject.ErrInvalidOperation) {
		t.Fatalf("nil repository error = %v", err)
	}
	if _, err := encryptedobject.NewDeleteOutboxDrainer(repository, nil); !errors.Is(err, encryptedobject.ErrInvalidOperation) {
		t.Fatalf("nil object store error = %v", err)
	}
	drainer, _ := encryptedobject.NewDeleteOutboxDrainer(repository, objects)
	for _, input := range []struct {
		attemptedAt, delay int64
		limit              int
	}{
		{0, 0, 1}, {1, -1, 1}, {identity.MaximumSafeInteger, 1, 1}, {1, 0, 0}, {1, 0, 101},
	} {
		if _, err := drainer.DrainBatch(context.Background(), input.attemptedAt, input.delay, input.limit); !errors.Is(err, encryptedobject.ErrInvalidOperation) {
			t.Fatalf("input %#v error = %v", input, err)
		}
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := drainer.DrainBatch(cancelled, 1, 0, 1); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled error = %v", err)
	}
}

type deleteOutboxRepositoryStub struct {
	entries         []encryptedobject.DeleteOutboxEntry
	pending         int64
	listErr         error
	countErr        error
	confirm         map[encryptedobject.ObjectKey]encryptedobject.DeleteOutboxMutationResult
	reschedule      map[encryptedobject.ObjectKey]encryptedobject.DeleteOutboxMutationResult
	rescheduled     []encryptedobject.DeleteOutboxEntry
	listAt          int64
	listLimit       int
	countCalls      int
	confirmCalls    int
	rescheduleCalls int
}

func (stub *deleteOutboxRepositoryStub) CountPending(context.Context) (int64, error) {
	stub.countCalls++
	return stub.pending, stub.countErr
}

func (stub *deleteOutboxRepositoryStub) ListReady(
	_ context.Context,
	attemptedAt int64,
	limit int,
) ([]encryptedobject.DeleteOutboxEntry, error) {
	stub.listAt = attemptedAt
	stub.listLimit = limit
	return append([]encryptedobject.DeleteOutboxEntry(nil), stub.entries...), stub.listErr
}

func (stub *deleteOutboxRepositoryStub) ConfirmDelete(
	_ context.Context,
	entry encryptedobject.DeleteOutboxEntry,
) (encryptedobject.DeleteOutboxMutationResult, error) {
	stub.confirmCalls++
	if mutation, found := stub.confirm[entry.ObjectKey]; found {
		return mutation, nil
	}
	return encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationApplied}, nil
}

func (stub *deleteOutboxRepositoryStub) RescheduleDelete(
	_ context.Context,
	entry encryptedobject.DeleteOutboxEntry,
) (encryptedobject.DeleteOutboxMutationResult, error) {
	stub.rescheduleCalls++
	stub.rescheduled = append(stub.rescheduled, entry)
	if mutation, found := stub.reschedule[entry.ObjectKey]; found {
		return mutation, nil
	}
	return encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationApplied}, nil
}

type deleteOutboxBehavior struct {
	result encryptedobject.DeleteResult
	err    error
}

type deleteOutboxObjectStub struct {
	behaviors   map[encryptedobject.ObjectKey]deleteOutboxBehavior
	afterDelete func()
	calls       int
}

func (stub *deleteOutboxObjectStub) Delete(
	_ context.Context,
	objectKey encryptedobject.ObjectKey,
) (encryptedobject.DeleteResult, error) {
	stub.calls++
	behavior := stub.behaviors[objectKey]
	if stub.afterDelete != nil {
		stub.afterDelete()
	}
	return behavior.result, behavior.err
}

func deleteOutboxKey(t *testing.T, character rune) encryptedobject.ObjectKey {
	t.Helper()
	key, err := encryptedobject.ParseObjectKey("obj_v1_" + strings.Repeat(string(character), 43))
	if err != nil {
		t.Fatal(err)
	}
	return key
}

func deleteOutboxEntry(
	key encryptedobject.ObjectKey,
	attempt int64,
	nextAttemptAt int64,
) encryptedobject.DeleteOutboxEntry {
	return encryptedobject.DeleteOutboxEntry{
		ObjectKey: key, AttemptCount: attempt, NextAttemptAt: nextAttemptAt, CreatedAtMilli: 1_000,
	}
}
