package recoverybackup

import (
	"context"
	"errors"
	"sync"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
)

var ErrMemoryOperation = errors.New("in-memory recovery backup operation failed")

type Operation string

const (
	OperationManifest   Operation = "manifest"
	OperationCiphertext Operation = "ciphertext"
)

type Seed struct {
	BackupID  encryptedobject.RecoveryBackupID
	ObjectKey encryptedobject.ObjectKey
	Bytes     []byte
}

type Calls struct {
	Manifest   int
	Ciphertext int
}

type Memory struct {
	mutex    sync.Mutex
	manifest []byte
	objects  map[string][]byte
	calls    Calls
	failures map[Operation]int
}

// NewMemory creates an isolated copying adapter for tests and local drills. It
// is not composed into the server and does not model a production backup.
func NewMemory(manifest []byte, seeds []Seed) (*Memory, error) {
	if len(manifest) == 0 {
		return nil, ErrMemoryOperation
	}
	memory := &Memory{
		manifest: append([]byte(nil), manifest...), objects: make(map[string][]byte, len(seeds)),
		failures: make(map[Operation]int),
	}
	for _, seed := range seeds {
		if _, err := encryptedobject.ParseRecoveryBackupID(string(seed.BackupID)); err != nil {
			return nil, ErrMemoryOperation
		}
		if _, err := encryptedobject.ParseObjectKey(string(seed.ObjectKey)); err != nil {
			return nil, ErrMemoryOperation
		}
		key := storageKey(seed.BackupID, seed.ObjectKey)
		if _, duplicate := memory.objects[key]; duplicate {
			return nil, ErrMemoryOperation
		}
		memory.objects[key] = append([]byte(nil), seed.Bytes...)
	}
	return memory, nil
}

func (memory *Memory) LoadManifest(context.Context, encryptedobject.RecoveryScope) ([]byte, error) {
	if memory == nil {
		return nil, ErrMemoryOperation
	}
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	memory.calls.Manifest++
	if memory.consumeFailure(OperationManifest) {
		return nil, ErrMemoryOperation
	}
	return append([]byte(nil), memory.manifest...), nil
}

func (memory *Memory) LoadCiphertext(
	_ context.Context,
	backupID encryptedobject.RecoveryBackupID,
	objectKey encryptedobject.ObjectKey,
) ([]byte, bool, error) {
	if memory == nil {
		return nil, false, ErrMemoryOperation
	}
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	memory.calls.Ciphertext++
	if memory.consumeFailure(OperationCiphertext) {
		return nil, false, ErrMemoryOperation
	}
	value, found := memory.objects[storageKey(backupID, objectKey)]
	if !found {
		return nil, false, nil
	}
	return append([]byte(nil), value...), true, nil
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

func (memory *Memory) ReplaceForTest(
	backupID encryptedobject.RecoveryBackupID,
	objectKey encryptedobject.ObjectKey,
	value []byte,
) error {
	if memory == nil {
		return ErrMemoryOperation
	}
	memory.mutex.Lock()
	defer memory.mutex.Unlock()
	key := storageKey(backupID, objectKey)
	if _, found := memory.objects[key]; !found {
		return ErrMemoryOperation
	}
	memory.objects[key] = append([]byte(nil), value...)
	return nil
}

func (memory *Memory) consumeFailure(operation Operation) bool {
	if memory.failures[operation] == 0 {
		return false
	}
	memory.failures[operation]--
	return true
}

func storageKey(backupID encryptedobject.RecoveryBackupID, objectKey encryptedobject.ObjectKey) string {
	return string(backupID) + ":" + string(objectKey)
}
