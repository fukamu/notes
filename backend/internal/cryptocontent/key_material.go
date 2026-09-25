package cryptocontent

import (
	"encoding/json"
	"errors"
	"sync"
)

var ErrDataEncryptionKeyUnavailable = errors.New("data encryption key is unavailable")

type DataEncryptionKey struct {
	mutex sync.RWMutex
	bytes []byte
}

func NewDataEncryptionKey(source []byte) (*DataEncryptionKey, error) {
	if len(source) != 32 {
		return nil, ErrInvalidEnvelope
	}
	return &DataEncryptionKey{bytes: append([]byte(nil), source...)}, nil
}

func (key *DataEncryptionKey) Use(operation func([]byte) error) error {
	if key == nil || operation == nil {
		return ErrDataEncryptionKeyUnavailable
	}
	key.mutex.RLock()
	if key.bytes == nil {
		key.mutex.RUnlock()
		return ErrDataEncryptionKeyUnavailable
	}
	workingCopy := append([]byte(nil), key.bytes...)
	key.mutex.RUnlock()
	defer clear(workingCopy)
	return operation(workingCopy)
}

func (key *DataEncryptionKey) Destroy() {
	if key == nil {
		return
	}
	key.mutex.Lock()
	clear(key.bytes)
	key.bytes = nil
	key.mutex.Unlock()
}

func (key *DataEncryptionKey) Destroyed() bool {
	if key == nil {
		return true
	}
	key.mutex.RLock()
	defer key.mutex.RUnlock()
	return key.bytes == nil
}

func (*DataEncryptionKey) String() string {
	return "[REDACTED data encryption key]"
}

func (*DataEncryptionKey) MarshalJSON() ([]byte, error) {
	return json.Marshal("[REDACTED data encryption key]")
}
