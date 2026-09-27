package syncv2

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/quota"
)

var ErrContentUnavailable = errors.New("Sync v2 encrypted content unavailable")

type ContentWriteResultKind string

const (
	ContentStored     ContentWriteResultKind = "stored"
	ContentReplayed   ContentWriteResultKind = "replayed"
	ContentNotApplied ContentWriteResultKind = "not-applied"
)

type ContentWriteResult struct {
	Kind   ContentWriteResultKind
	Reason encryptedobject.RejectionReason
}

type ContentRepository interface {
	ReadCard(context.Context, CardID, Revision) (*StoredCard, error)
	ReadConflict(context.Context, ConflictID) (*StoredConflict, error)
	WriteCard(context.Context, CardID, *Revision, Revision, MutationID, StoredCard, int64) (ContentWriteResult, error)
	WriteConflict(context.Context, ConflictID, MutationID, StoredConflict, int64) (ContentWriteResult, error)
}

type ContentOpenResultKind string

const (
	ContentOpened        ContentOpenResultKind = "opened"
	ContentOwnerMismatch ContentOpenResultKind = "owner-mismatch"
)

type ContentOpenResult struct {
	Kind       ContentOpenResultKind
	Repository ContentRepository
}

type ContentDirectory interface {
	Open(context.Context, identity.VaultContext) (ContentOpenResult, error)
}

type MetadataOpenResult struct {
	Kind       ContentOpenResultKind
	Repository encryptedobject.MetadataRepository
}

type MetadataDirectory interface {
	Open(context.Context, identity.VaultContext) (MetadataOpenResult, error)
}

type KeyringReader interface {
	FindKeyring(context.Context, identity.VaultID) (*cryptocontent.VaultDEKKeyring, error)
}

type EncryptedContentDirectory struct {
	metadata   MetadataDirectory
	objects    encryptedobject.ObjectStoragePort
	objectKeys encryptedobject.ObjectKeyGeneratorPort
	encryption encryptedobject.EncryptionPort
	keyrings   KeyringReader
}

func NewEncryptedContentDirectory(
	metadata MetadataDirectory,
	objects encryptedobject.ObjectStoragePort,
	objectKeys encryptedobject.ObjectKeyGeneratorPort,
	encryption encryptedobject.EncryptionPort,
	keyrings KeyringReader,
) (*EncryptedContentDirectory, error) {
	if metadata == nil || objects == nil || objectKeys == nil || encryption == nil || keyrings == nil {
		return nil, ErrContentUnavailable
	}
	return &EncryptedContentDirectory{
		metadata: metadata, objects: objects, objectKeys: objectKeys,
		encryption: encryption, keyrings: keyrings,
	}, nil
}

func (directory *EncryptedContentDirectory) Open(
	ctx context.Context,
	vaultContext identity.VaultContext,
) (ContentOpenResult, error) {
	if directory == nil || directory.metadata == nil || directory.objects == nil ||
		directory.objectKeys == nil || directory.encryption == nil || directory.keyrings == nil ||
		!validVaultContext(vaultContext) {
		return ContentOpenResult{}, ErrContentUnavailable
	}
	opened, err := directory.metadata.Open(ctx, vaultContext)
	if err != nil {
		return ContentOpenResult{}, err
	}
	if opened.Kind == ContentOwnerMismatch {
		return ContentOpenResult{Kind: ContentOwnerMismatch}, nil
	}
	if opened.Kind != ContentOpened || opened.Repository == nil {
		return ContentOpenResult{}, ErrContentUnavailable
	}
	keyring, err := directory.keyrings.FindKeyring(ctx, vaultContext.VaultID)
	if err != nil {
		return ContentOpenResult{}, err
	}
	if keyring == nil || cryptocontent.ValidateVaultDEKKeyring(*keyring) != nil ||
		keyring.VaultID != vaultContext.VaultID {
		return ContentOpenResult{}, ErrContentUnavailable
	}
	limit := quota.MaximumCiphertextBytesPerObject
	service, err := encryptedobject.NewService(
		vaultContext.VaultID, opened.Repository, directory.objects,
		directory.objectKeys, directory.encryption, &limit,
	)
	if err != nil {
		return ContentOpenResult{}, ErrContentUnavailable
	}
	return ContentOpenResult{
		Kind:       ContentOpened,
		Repository: &encryptedContentRepository{service: service, keyring: *keyring},
	}, nil
}

type encryptedContentRepository struct {
	service *encryptedobject.Service
	keyring cryptocontent.VaultDEKKeyring
}

func (repository *encryptedContentRepository) ReadCard(
	ctx context.Context,
	cardID CardID,
	revision Revision,
) (*StoredCard, error) {
	if repository == nil || repository.service == nil {
		return nil, ErrContentUnavailable
	}
	objectRevision, err := cryptocontent.ParseObjectRevision(int64(revision))
	if err != nil {
		return nil, ErrContentUnavailable
	}
	result, err := repository.service.ReadRevision(ctx, encryptedobject.ObjectRef{
		Kind: cryptocontent.ObjectCard, ObjectID: string(cardID),
	}, objectRevision, repository.keyring)
	if err != nil {
		return nil, err
	}
	if !result.Found {
		return nil, nil
	}
	defer clear(result.Plaintext)
	content, err := DecodeStoredCard(result.Plaintext)
	if err != nil {
		return nil, ErrContentUnavailable
	}
	return &content, nil
}

func (repository *encryptedContentRepository) ReadConflict(
	ctx context.Context,
	conflictID ConflictID,
) (*StoredConflict, error) {
	if repository == nil || repository.service == nil {
		return nil, ErrContentUnavailable
	}
	revision, err := cryptocontent.ParseObjectRevision(1)
	if err != nil {
		return nil, ErrContentUnavailable
	}
	result, err := repository.service.ReadRevision(ctx, encryptedobject.ObjectRef{
		Kind: cryptocontent.ObjectConflict, ObjectID: string(conflictID),
	}, revision, repository.keyring)
	if err != nil {
		return nil, err
	}
	if !result.Found {
		return nil, nil
	}
	defer clear(result.Plaintext)
	content, err := DecodeStoredConflict(result.Plaintext)
	if err != nil {
		return nil, ErrContentUnavailable
	}
	return &content, nil
}

func (repository *encryptedContentRepository) WriteCard(
	ctx context.Context,
	cardID CardID,
	expectedRevision *Revision,
	nextRevision Revision,
	writeID MutationID,
	content StoredCard,
	writtenAt int64,
) (ContentWriteResult, error) {
	plaintext, err := EncodeStoredCard(content)
	if err != nil {
		return ContentWriteResult{}, ErrContentUnavailable
	}
	defer clear(plaintext)
	return repository.write(ctx, encryptedobject.ObjectRef{
		Kind: cryptocontent.ObjectCard, ObjectID: string(cardID),
	}, expectedRevision, nextRevision, writeID, plaintext, writtenAt)
}

func (repository *encryptedContentRepository) WriteConflict(
	ctx context.Context,
	conflictID ConflictID,
	writeID MutationID,
	content StoredConflict,
	writtenAt int64,
) (ContentWriteResult, error) {
	plaintext, err := EncodeStoredConflict(content)
	if err != nil {
		return ContentWriteResult{}, ErrContentUnavailable
	}
	defer clear(plaintext)
	return repository.write(ctx, encryptedobject.ObjectRef{
		Kind: cryptocontent.ObjectConflict, ObjectID: string(conflictID),
	}, nil, 1, writeID, plaintext, writtenAt)
}

func (repository *encryptedContentRepository) write(
	ctx context.Context,
	object encryptedobject.ObjectRef,
	expectedRevision *Revision,
	nextRevision Revision,
	writeID MutationID,
	plaintext []byte,
	writtenAt int64,
) (ContentWriteResult, error) {
	if repository == nil || repository.service == nil {
		return ContentWriteResult{}, ErrContentUnavailable
	}
	parsedWriteID, err := encryptedobject.ParseWriteID(string(writeID))
	if err != nil {
		return ContentWriteResult{}, ErrContentUnavailable
	}
	parsedNext, err := cryptocontent.ParseObjectRevision(int64(nextRevision))
	if err != nil {
		return ContentWriteResult{}, ErrContentUnavailable
	}
	var parsedExpected *cryptocontent.ObjectRevision
	if expectedRevision != nil {
		value, err := cryptocontent.ParseObjectRevision(int64(*expectedRevision))
		if err != nil {
			return ContentWriteResult{}, ErrContentUnavailable
		}
		parsedExpected = &value
	}
	result, err := repository.service.Write(ctx, encryptedobject.WriteCommand{
		Object: object, ExpectedRevision: parsedExpected, NextRevision: parsedNext,
		WriteID: parsedWriteID, Plaintext: plaintext, Keyring: repository.keyring,
		CreatedAtMilli: writtenAt,
	})
	if err != nil {
		return ContentWriteResult{}, err
	}
	switch result.Kind {
	case encryptedobject.WriteStored:
		return ContentWriteResult{Kind: ContentStored}, nil
	case encryptedobject.WriteReplayed:
		return ContentWriteResult{Kind: ContentReplayed}, nil
	case encryptedobject.WriteNotApplied:
		return ContentWriteResult{Kind: ContentNotApplied, Reason: result.Reason}, nil
	default:
		return ContentWriteResult{}, ErrContentUnavailable
	}
}

func validVaultContext(vaultContext identity.VaultContext) bool {
	_, accountErr := identity.ParseAccountID(string(vaultContext.AccountID))
	_, vaultErr := identity.ParseVaultID(string(vaultContext.VaultID))
	return accountErr == nil && vaultErr == nil
}
