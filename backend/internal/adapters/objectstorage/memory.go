package objectstorage

import (
	"bytes"
	"context"
	"errors"
	"sort"
	"sync"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

var ErrMemoryOperation = errors.New("in-memory private object storage operation failed")

type Operation string

const (
	OperationGet    Operation = "get"
	OperationPut    Operation = "put"
	OperationDelete Operation = "delete"
	OperationList   Operation = "list"
)

type Seed struct {
	ObjectKey      encryptedobject.ObjectKey
	Bytes          []byte
	CreatedAtMilli int64
}

type Calls struct {
	Get    int
	Put    int
	Delete int
	List   int
}

type storedObject struct {
	bytes          []byte
	createdAtMilli int64
}

// Memory is an isolated deterministic adapter for tests and local drills. It is
// not composed into the production server.
type Memory struct {
	mutex          sync.Mutex
	objects        map[encryptedobject.ObjectKey]storedObject
	calls          Calls
	failures       map[Operation]int
	deleteFailures map[encryptedobject.ObjectKey]struct{}
}

func NewMemory(seed []Seed) (*Memory, error) {
	result := &Memory{
		objects:  make(map[encryptedobject.ObjectKey]storedObject, len(seed)),
		failures: make(map[Operation]int), deleteFailures: make(map[encryptedobject.ObjectKey]struct{}),
	}
	for _, entry := range seed {
		if _, err := encryptedobject.ParseObjectKey(string(entry.ObjectKey)); err != nil || entry.CreatedAtMilli < 0 {
			return nil, ErrMemoryOperation
		}
		if _, duplicate := result.objects[entry.ObjectKey]; duplicate {
			return nil, ErrMemoryOperation
		}
		result.objects[entry.ObjectKey] = storedObject{
			bytes: append([]byte(nil), entry.Bytes...), createdAtMilli: entry.CreatedAtMilli,
		}
	}
	return result, nil
}

func (memory *Memory) Get(
	_ context.Context,
	objectKey encryptedobject.ObjectKey,
) ([]byte, bool, error) {
	if memory == nil {
		return nil, false, ErrMemoryOperation
	}
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	memory.calls.Get++
	if _, err := encryptedobject.ParseObjectKey(string(objectKey)); err != nil || memory.consumeFailure(OperationGet) {
		return nil, false, ErrMemoryOperation
	}
	stored, found := memory.objects[objectKey]
	if !found {
		return nil, false, nil
	}
	return append([]byte(nil), stored.bytes...), true, nil
}

func (memory *Memory) PutIfAbsent(
	_ context.Context,
	objectKey encryptedobject.ObjectKey,
	value []byte,
	createdAtMilli int64,
) (encryptedobject.PutResult, error) {
	if memory == nil {
		return "", ErrMemoryOperation
	}
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	memory.calls.Put++
	if _, err := encryptedobject.ParseObjectKey(string(objectKey)); err != nil ||
		createdAtMilli < 0 || createdAtMilli > 9_007_199_254_740_991 ||
		len(value) > int(encryptedobject.MaximumStoredBytes) || memory.consumeFailure(OperationPut) {
		return "", ErrMemoryOperation
	}
	if stored, found := memory.objects[objectKey]; found {
		if bytes.Equal(stored.bytes, value) {
			return encryptedobject.PutAlreadyPresent, nil
		}
		return encryptedobject.PutConflict, nil
	}
	memory.objects[objectKey] = storedObject{
		bytes: append([]byte(nil), value...), createdAtMilli: createdAtMilli,
	}
	return encryptedobject.PutStored, nil
}

func (memory *Memory) Delete(
	_ context.Context,
	objectKey encryptedobject.ObjectKey,
) (encryptedobject.DeleteResult, error) {
	if memory == nil {
		return "", ErrMemoryOperation
	}
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	memory.calls.Delete++
	if _, err := encryptedobject.ParseObjectKey(string(objectKey)); err != nil || memory.consumeFailure(OperationDelete) {
		return "", ErrMemoryOperation
	}
	if _, fail := memory.deleteFailures[objectKey]; fail {
		delete(memory.deleteFailures, objectKey)
		return "", ErrMemoryOperation
	}
	if _, found := memory.objects[objectKey]; !found {
		return encryptedobject.DeleteNotFound, nil
	}
	delete(memory.objects, objectKey)
	return encryptedobject.DeleteDeleted, nil
}

func (memory *Memory) List(context.Context) ([]encryptedobject.PrivateObjectDescriptor, error) {
	if memory == nil {
		return nil, ErrMemoryOperation
	}
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	memory.calls.List++
	if memory.consumeFailure(OperationList) {
		return nil, ErrMemoryOperation
	}
	result := make([]encryptedobject.PrivateObjectDescriptor, 0, len(memory.objects))
	for objectKey, stored := range memory.objects {
		result = append(result, encryptedobject.PrivateObjectDescriptor{
			ObjectKey: objectKey, CreatedAtMilli: stored.createdAtMilli,
		})
	}
	sort.Slice(result, func(left, right int) bool { return result[left].ObjectKey < result[right].ObjectKey })
	return result, nil
}

func (memory *Memory) Calls() Calls {
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	return memory.calls
}

func (memory *Memory) FailNext(operation Operation) {
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	memory.failures[operation]++
}

func (memory *Memory) FailDeleteForTest(objectKey encryptedobject.ObjectKey) {
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	memory.deleteFailures[objectKey] = struct{}{}
}

func (memory *Memory) ReplaceForTest(objectKey encryptedobject.ObjectKey, value []byte) error {
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	stored, found := memory.objects[objectKey]
	if !found {
		return ErrMemoryOperation
	}
	stored.bytes = append([]byte(nil), value...)
	memory.objects[objectKey] = stored
	return nil
}

func (memory *Memory) consumeFailure(operation Operation) bool {
	if memory.failures[operation] == 0 {
		return false
	}
	memory.failures[operation]--
	return true
}
