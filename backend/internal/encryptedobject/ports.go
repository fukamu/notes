package encryptedobject

import (
	"context"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
)

type PutResult string

const (
	PutStored         PutResult = "stored"
	PutAlreadyPresent PutResult = "already-present"
	PutConflict       PutResult = "conflict"
)

type DeleteResult string

const (
	DeleteDeleted  DeleteResult = "deleted"
	DeleteNotFound DeleteResult = "not-found"
)

type ObjectStoragePort interface {
	Get(context.Context, ObjectKey) ([]byte, bool, error)
	PutIfAbsent(context.Context, ObjectKey, []byte, int64) (PutResult, error)
	Delete(context.Context, ObjectKey) (DeleteResult, error)
	List(context.Context) ([]PrivateObjectDescriptor, error)
}

type ObjectKeyGeneratorPort interface {
	CreateObjectKey(context.Context) (string, error)
}

type EncryptionPort interface {
	Encrypt(context.Context, cryptocontent.VaultDEKKeyring, cryptocontent.ObjectContext, []byte) (cryptocontent.EnvelopeCiphertext, error)
	Decrypt(context.Context, cryptocontent.VaultDEKKeyring, cryptocontent.ObjectContext, cryptocontent.EnvelopeCiphertext) ([]byte, error)
}

type IntentReservationKind string

const (
	IntentReserved IntentReservationKind = "reserved"
	IntentExisting IntentReservationKind = "existing"
	IntentConflict IntentReservationKind = "conflict"
)

type IntentReservation struct {
	Kind   IntentReservationKind
	Intent PendingWrite
}

type MetadataCommitKind string

const (
	MetadataApplied    MetadataCommitKind = "applied"
	MetadataNotApplied MetadataCommitKind = "not-applied"
)

type MetadataCommit struct {
	Kind     MetadataCommitKind
	Metadata Metadata
}

type MetadataRepository interface {
	FindCurrent(context.Context, ObjectRef) (*Metadata, error)
	FindRevision(context.Context, ObjectRef, cryptocontent.ObjectRevision) (*Metadata, error)
	FindByWriteID(context.Context, WriteID) (*Metadata, error)
	FindIntent(context.Context, WriteID) (*PendingWrite, error)
	ReserveIntent(context.Context, PendingWrite) (IntentReservation, error)
	CommitIntent(context.Context, PendingWrite, int64) (MetadataCommit, error)
	AbandonIntent(context.Context, PendingWrite, int64) error
	ListProtectedObjectKeys(context.Context) (map[ObjectKey]struct{}, error)
	EnqueueDelete(context.Context, ObjectKey, int64) (bool, error)
	ListReadyDeletes(context.Context, int64, int) ([]DeleteOutboxEntry, error)
	CompleteDelete(context.Context, DeleteOutboxEntry) error
	RescheduleDelete(context.Context, DeleteOutboxEntry) error
}
