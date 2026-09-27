package encryptedobject

import (
	"errors"
	"regexp"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

const MaximumStoredBytes = int64(134_217_728)

var (
	ErrInvalidValue  = errors.New("invalid encrypted object value")
	uuidPattern      = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[1-8][0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`)
	uuidV7Pattern    = regexp.MustCompile(`^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-7[0-9A-Fa-f]{3}-[89ABab][0-9A-Fa-f]{3}-[0-9A-Fa-f]{12}$`)
	objectKeyPattern = regexp.MustCompile(`^obj_v1_[A-Za-z0-9_-]{43}$`)
)

type WriteID string
type ObjectKey string

type ObjectRef struct {
	Kind     cryptocontent.ObjectKind
	ObjectID string
}

type Metadata struct {
	Object          ObjectRef
	ObjectRevision  cryptocontent.ObjectRevision
	WriteID         WriteID
	ObjectKey       ObjectKey
	PlaintextBytes  int64
	CiphertextBytes int64
	CryptoVersion   string
	DEKVersion      cryptocontent.DEKVersion
	CreatedAtMilli  int64
}

type PendingWrite struct {
	Object           ObjectRef
	ExpectedRevision *cryptocontent.ObjectRevision
	ObjectRevision   cryptocontent.ObjectRevision
	WriteID          WriteID
	ObjectKey        ObjectKey
	PlaintextBytes   int64
	CryptoVersion    string
	DEKVersion       cryptocontent.DEKVersion
	CreatedAtMilli   int64
}

type WriteRequest struct {
	Object           ObjectRef
	ExpectedRevision *cryptocontent.ObjectRevision
	NextRevision     cryptocontent.ObjectRevision
	WriteID          WriteID
	PlaintextBytes   int64
	DEKVersion       cryptocontent.DEKVersion
	CreatedAtMilli   int64
}

type PrivateObjectDescriptor struct {
	ObjectKey      ObjectKey
	CreatedAtMilli int64
}

type DeleteOutboxEntry struct {
	ObjectKey      ObjectKey
	AttemptCount   int64
	NextAttemptAt  int64
	CreatedAtMilli int64
}

func ParseWriteID(value string) (WriteID, error) {
	if !uuidPattern.MatchString(value) {
		return "", ErrInvalidValue
	}
	return WriteID(value), nil
}

func ParseObjectKey(value string) (ObjectKey, error) {
	if !objectKeyPattern.MatchString(value) {
		return "", ErrInvalidValue
	}
	return ObjectKey(value), nil
}

func ValidateObjectRef(value ObjectRef) error {
	if (value.Kind != cryptocontent.ObjectCard && value.Kind != cryptocontent.ObjectConflict) ||
		!uuidV7Pattern.MatchString(value.ObjectID) {
		return ErrInvalidValue
	}
	return nil
}

func ValidateMetadata(value Metadata) error {
	if ValidateObjectRef(value.Object) != nil || validateRevision(value.ObjectRevision) != nil ||
		validateWriteID(value.WriteID) != nil || validateObjectKey(value.ObjectKey) != nil ||
		!validByteCount(value.PlaintextBytes) || value.CiphertextBytes < 1 ||
		value.CiphertextBytes > MaximumStoredBytes || value.CryptoVersion != cryptocontent.EnvelopeCryptoVersion ||
		validateDEKVersion(value.DEKVersion) != nil || !validTimestamp(value.CreatedAtMilli) {
		return ErrInvalidValue
	}
	return nil
}

func ValidatePendingWrite(value PendingWrite) error {
	if ValidateObjectRef(value.Object) != nil || validateOptionalRevision(value.ExpectedRevision) != nil ||
		validateRevision(value.ObjectRevision) != nil || validateWriteID(value.WriteID) != nil ||
		validateObjectKey(value.ObjectKey) != nil || !validByteCount(value.PlaintextBytes) ||
		value.CryptoVersion != cryptocontent.EnvelopeCryptoVersion ||
		validateDEKVersion(value.DEKVersion) != nil || !validTimestamp(value.CreatedAtMilli) {
		return ErrInvalidValue
	}
	return nil
}

func ValidateWriteRequest(value WriteRequest) error {
	if ValidateObjectRef(value.Object) != nil || validateOptionalRevision(value.ExpectedRevision) != nil ||
		validateRevision(value.NextRevision) != nil || validateWriteID(value.WriteID) != nil ||
		!validByteCount(value.PlaintextBytes) || validateDEKVersion(value.DEKVersion) != nil ||
		!validTimestamp(value.CreatedAtMilli) {
		return ErrInvalidValue
	}
	return nil
}

func validateWriteID(value WriteID) error {
	_, err := ParseWriteID(string(value))
	return err
}

func validateObjectKey(value ObjectKey) error {
	_, err := ParseObjectKey(string(value))
	return err
}

func validateRevision(value cryptocontent.ObjectRevision) error {
	_, err := cryptocontent.ParseObjectRevision(int64(value))
	return err
}

func validateOptionalRevision(value *cryptocontent.ObjectRevision) error {
	if value == nil {
		return nil
	}
	return validateRevision(*value)
}

func validateDEKVersion(value cryptocontent.DEKVersion) error {
	_, err := cryptocontent.ParseDEKVersion(int64(value))
	return err
}

func validByteCount(value int64) bool {
	return value >= 0 && value <= MaximumStoredBytes
}

func validTimestamp(value int64) bool {
	return value >= 0 && value <= identity.MaximumSafeInteger
}
