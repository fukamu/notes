package encryptedobject

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

var (
	ErrInvalidOperation = errors.New("invalid encrypted object operation")
	ErrIntegrity        = errors.New("encrypted object integrity validation failed")
	ErrStorageConflict  = errors.New("immutable encrypted object already has different content")
)

type WriteResultKind string

const (
	WriteStored     WriteResultKind = "stored"
	WriteReplayed   WriteResultKind = "replayed"
	WriteNotApplied WriteResultKind = "not-applied"
)

type WriteResult struct {
	Kind     WriteResultKind
	Metadata Metadata
	Reason   RejectionReason
}

type ReadResult struct {
	Found     bool
	Plaintext []byte
}

type WriteCommand struct {
	Object           ObjectRef
	ExpectedRevision *cryptocontent.ObjectRevision
	NextRevision     cryptocontent.ObjectRevision
	WriteID          WriteID
	Plaintext        []byte
	Keyring          cryptocontent.VaultDEKKeyring
	CreatedAtMilli   int64
}

type Service struct {
	vaultID                identity.VaultID
	metadata               MetadataRepository
	objects                ObjectStoragePort
	objectKeys             ObjectKeyGeneratorPort
	encryption             EncryptionPort
	maximumCiphertextBytes *int64
}

func NewService(
	vaultID identity.VaultID,
	metadata MetadataRepository,
	objects ObjectStoragePort,
	objectKeys ObjectKeyGeneratorPort,
	encryption EncryptionPort,
	maximumCiphertextBytes *int64,
) (*Service, error) {
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil || metadata == nil || objects == nil ||
		objectKeys == nil || encryption == nil {
		return nil, ErrInvalidOperation
	}
	if maximumCiphertextBytes != nil && !validByteCount(*maximumCiphertextBytes) {
		return nil, ErrInvalidOperation
	}
	var copiedLimit *int64
	if maximumCiphertextBytes != nil {
		value := *maximumCiphertextBytes
		copiedLimit = &value
	}
	return &Service{
		vaultID: vaultID, metadata: metadata, objects: objects, objectKeys: objectKeys,
		encryption: encryption, maximumCiphertextBytes: copiedLimit,
	}, nil
}

func (service *Service) Write(ctx context.Context, command WriteCommand) (WriteResult, error) {
	request := WriteRequest{
		Object: command.Object, ExpectedRevision: copyRevision(command.ExpectedRevision),
		NextRevision: command.NextRevision, WriteID: command.WriteID,
		PlaintextBytes: int64(len(command.Plaintext)), DEKVersion: command.Keyring.WriteVersion,
		CreatedAtMilli: command.CreatedAtMilli,
	}
	if service == nil || ValidateWriteRequest(request) != nil || service.metadata == nil || service.objects == nil ||
		service.objectKeys == nil || service.encryption == nil {
		return WriteResult{}, ErrInvalidOperation
	}
	if _, err := command.Keyring.SelectForWrite(service.vaultID); err != nil {
		return WriteResult{}, ErrInvalidOperation
	}

	existingWrite, err := service.metadata.FindByWriteID(ctx, command.WriteID)
	if err != nil {
		return WriteResult{}, err
	}
	if existingWrite != nil {
		plan := PlanWrite(existingWrite, nil, request)
		if plan.Kind == WritePlanReplay && plan.Metadata != nil {
			if service.exceedsLimit(plan.Metadata.CiphertextBytes) {
				return WriteResult{Kind: WriteNotApplied, Reason: ReasonCiphertextLimit}, nil
			}
			return WriteResult{Kind: WriteReplayed, Metadata: *plan.Metadata}, nil
		}
		if plan.Kind == WritePlanRejected {
			return WriteResult{Kind: WriteNotApplied, Reason: plan.Reason}, nil
		}
		return WriteResult{}, ErrIntegrity
	}

	existingIntent, err := service.metadata.FindIntent(ctx, command.WriteID)
	if err != nil {
		return WriteResult{}, err
	}
	var intent PendingWrite
	if existingIntent != nil {
		if !PendingMatchesRequest(*existingIntent, request) {
			return WriteResult{Kind: WriteNotApplied, Reason: ReasonIdempotencyKeyReuse}, nil
		}
		intent = *existingIntent
	} else {
		current, findErr := service.metadata.FindCurrent(ctx, command.Object)
		if findErr != nil {
			return WriteResult{}, findErr
		}
		plan := PlanWrite(nil, current, request)
		if plan.Kind == WritePlanRejected {
			return WriteResult{Kind: WriteNotApplied, Reason: plan.Reason}, nil
		}
		if plan.Kind != WritePlanAccepted {
			return WriteResult{}, ErrIntegrity
		}
		rawObjectKey, createErr := service.objectKeys.CreateObjectKey(ctx)
		if createErr != nil {
			return WriteResult{}, createErr
		}
		objectKey, parseErr := ParseObjectKey(rawObjectKey)
		if parseErr != nil {
			return WriteResult{}, ErrInvalidOperation
		}
		proposed := PendingWrite{
			Object: command.Object, ExpectedRevision: copyRevision(command.ExpectedRevision),
			ObjectRevision: command.NextRevision, WriteID: command.WriteID, ObjectKey: objectKey,
			PlaintextBytes: request.PlaintextBytes, CryptoVersion: cryptocontent.EnvelopeCryptoVersion,
			DEKVersion: request.DEKVersion, CreatedAtMilli: command.CreatedAtMilli,
		}
		reservation, reserveErr := service.metadata.ReserveIntent(ctx, proposed)
		if reserveErr != nil {
			return WriteResult{}, reserveErr
		}
		if reservation.Kind == IntentConflict {
			return WriteResult{Kind: WriteNotApplied, Reason: ReasonCASConflict}, nil
		}
		if (reservation.Kind != IntentReserved && reservation.Kind != IntentExisting) ||
			!PendingMatchesRequest(reservation.Intent, request) {
			if reservation.Kind == IntentReserved || reservation.Kind == IntentExisting {
				return WriteResult{Kind: WriteNotApplied, Reason: ReasonIdempotencyKeyReuse}, nil
			}
			return WriteResult{}, ErrIntegrity
		}
		intent = reservation.Intent
	}
	currentAfterReservation, err := service.metadata.FindCurrent(ctx, command.Object)
	if err != nil {
		return WriteResult{}, err
	}
	reservationPlan := PlanWrite(nil, currentAfterReservation, request)
	if reservationPlan.Kind != WritePlanAccepted {
		if err := service.metadata.AbandonIntent(ctx, intent, command.CreatedAtMilli); err != nil {
			return WriteResult{}, err
		}
		return WriteResult{Kind: WriteNotApplied, Reason: ReasonCASConflict}, nil
	}

	storedBytes, found, err := service.objects.Get(ctx, intent.ObjectKey)
	if err != nil {
		return WriteResult{}, err
	}
	authenticateExisting := found
	if !found {
		plaintextForEncryption := append([]byte(nil), command.Plaintext...)
		ciphertext, encryptErr := service.encryption.Encrypt(
			ctx,
			command.Keyring,
			service.objectContext(intent.Object, intent.ObjectRevision),
			plaintextForEncryption,
		)
		clear(plaintextForEncryption)
		if encryptErr != nil {
			return WriteResult{}, encryptErr
		}
		storedBytes, err = encodeCiphertext(ciphertext)
		if err != nil {
			return WriteResult{}, ErrIntegrity
		}
		if service.exceedsLimit(int64(len(storedBytes))) {
			if err := service.metadata.AbandonIntent(ctx, intent, command.CreatedAtMilli); err != nil {
				return WriteResult{}, err
			}
			return WriteResult{Kind: WriteNotApplied, Reason: ReasonCiphertextLimit}, nil
		}
		put, putErr := service.objects.PutIfAbsent(ctx, intent.ObjectKey, storedBytes, intent.CreatedAtMilli)
		if putErr != nil {
			return WriteResult{}, putErr
		}
		switch put {
		case PutStored:
		case PutAlreadyPresent:
			storedBytes, found, err = service.objects.Get(ctx, intent.ObjectKey)
			if err != nil {
				return WriteResult{}, err
			}
			if !found {
				return WriteResult{}, ErrIntegrity
			}
			authenticateExisting = true
		case PutConflict:
			return WriteResult{}, ErrStorageConflict
		default:
			return WriteResult{}, ErrIntegrity
		}
	}
	if service.exceedsLimit(int64(len(storedBytes))) {
		if err := service.metadata.AbandonIntent(ctx, intent, command.CreatedAtMilli); err != nil {
			return WriteResult{}, err
		}
		return WriteResult{Kind: WriteNotApplied, Reason: ReasonCiphertextLimit}, nil
	}
	ciphertext, err := cryptocontent.DecodeEnvelopeCiphertext(storedBytes)
	if err != nil || !StoredCiphertextMatches(
		intent.CryptoVersion, intent.DEKVersion, nil, ciphertext, int64(len(storedBytes)),
	) {
		return WriteResult{}, ErrIntegrity
	}
	if authenticateExisting {
		authenticated, decryptErr := service.encryption.Decrypt(
			ctx, command.Keyring, service.objectContext(intent.Object, intent.ObjectRevision), ciphertext,
		)
		matches := decryptErr == nil && constantTimeEqual(authenticated, command.Plaintext)
		clear(authenticated)
		if !matches {
			return WriteResult{}, ErrIntegrity
		}
	}
	commit, err := service.metadata.CommitIntent(ctx, intent, int64(len(storedBytes)))
	if err != nil {
		return WriteResult{}, err
	}
	if commit.Kind == MetadataNotApplied {
		if err := service.metadata.AbandonIntent(ctx, intent, command.CreatedAtMilli); err != nil {
			return WriteResult{}, err
		}
		return WriteResult{Kind: WriteNotApplied, Reason: ReasonCASConflict}, nil
	}
	if commit.Kind != MetadataApplied || ValidateMetadata(commit.Metadata) != nil {
		return WriteResult{}, ErrIntegrity
	}
	return WriteResult{Kind: WriteStored, Metadata: commit.Metadata}, nil
}

func (service *Service) Read(
	ctx context.Context,
	object ObjectRef,
	keyring cryptocontent.VaultDEKKeyring,
) (ReadResult, error) {
	if service == nil || ValidateObjectRef(object) != nil {
		return ReadResult{}, ErrInvalidOperation
	}
	metadata, err := service.metadata.FindCurrent(ctx, object)
	if err != nil {
		return ReadResult{}, err
	}
	return service.readMetadata(ctx, keyring, metadata)
}

func (service *Service) ReadRevision(
	ctx context.Context,
	object ObjectRef,
	revision cryptocontent.ObjectRevision,
	keyring cryptocontent.VaultDEKKeyring,
) (ReadResult, error) {
	if service == nil || ValidateObjectRef(object) != nil || validateRevision(revision) != nil {
		return ReadResult{}, ErrInvalidOperation
	}
	metadata, err := service.metadata.FindRevision(ctx, object, revision)
	if err != nil {
		return ReadResult{}, err
	}
	return service.readMetadata(ctx, keyring, metadata)
}

func (service *Service) CollectOrphans(
	ctx context.Context,
	scanStartedAt, gracePeriodMilli int64,
) (int, error) {
	if service == nil || !validTimestamp(scanStartedAt) || gracePeriodMilli < 0 ||
		gracePeriodMilli > identity.MaximumSafeInteger {
		return 0, ErrInvalidOperation
	}
	stored, err := service.objects.List(ctx)
	if err != nil {
		return 0, err
	}
	protected, err := service.metadata.ListProtectedObjectKeys(ctx)
	if err != nil {
		return 0, err
	}
	enqueued := 0
	for _, objectKey := range PlanOrphanCollection(stored, protected, scanStartedAt, gracePeriodMilli) {
		applied, enqueueErr := service.metadata.EnqueueDelete(ctx, objectKey, scanStartedAt)
		if enqueueErr != nil {
			return 0, enqueueErr
		}
		if applied {
			enqueued++
		}
	}
	return enqueued, nil
}

func (service *Service) DrainDeleteOutbox(
	ctx context.Context,
	now, retryDelayMilli int64,
	limit int,
) (completed, retried int, err error) {
	if service == nil || !validTimestamp(now) || retryDelayMilli < 0 ||
		retryDelayMilli > identity.MaximumSafeInteger || now > identity.MaximumSafeInteger-retryDelayMilli ||
		limit < 1 || limit > 100 {
		return 0, 0, ErrInvalidOperation
	}
	entries, err := service.metadata.ListReadyDeletes(ctx, now, limit)
	if err != nil {
		return 0, 0, err
	}
	for _, entry := range entries {
		result, deleteErr := service.objects.Delete(ctx, entry.ObjectKey)
		succeeded := deleteErr == nil && (result == DeleteDeleted || result == DeleteNotFound)
		planned, complete := PlanDeleteAttempt(entry, succeeded, now, retryDelayMilli)
		if complete {
			if err := service.metadata.CompleteDelete(ctx, entry); err != nil {
				return completed, retried, err
			}
			completed++
			continue
		}
		if err := service.metadata.RescheduleDelete(ctx, planned); err != nil {
			return completed, retried, err
		}
		retried++
	}
	return completed, retried, nil
}

func (service *Service) readMetadata(
	ctx context.Context,
	keyring cryptocontent.VaultDEKKeyring,
	metadata *Metadata,
) (ReadResult, error) {
	if metadata == nil {
		return ReadResult{Found: false}, nil
	}
	if ValidateMetadata(*metadata) != nil || service.exceedsLimit(metadata.CiphertextBytes) {
		return ReadResult{}, ErrIntegrity
	}
	stored, found, err := service.objects.Get(ctx, metadata.ObjectKey)
	if err != nil {
		return ReadResult{}, err
	}
	if !found {
		return ReadResult{}, ErrIntegrity
	}
	ciphertext, err := cryptocontent.DecodeEnvelopeCiphertext(stored)
	if err != nil || !StoredCiphertextMatches(
		metadata.CryptoVersion, metadata.DEKVersion, &metadata.CiphertextBytes,
		ciphertext, int64(len(stored)),
	) {
		return ReadResult{}, ErrIntegrity
	}
	plaintext, err := service.encryption.Decrypt(
		ctx, keyring, service.objectContext(metadata.Object, metadata.ObjectRevision), ciphertext,
	)
	if err != nil || int64(len(plaintext)) != metadata.PlaintextBytes {
		return ReadResult{}, ErrIntegrity
	}
	return ReadResult{Found: true, Plaintext: plaintext}, nil
}

func (service *Service) objectContext(object ObjectRef, revision cryptocontent.ObjectRevision) cryptocontent.ObjectContext {
	return cryptocontent.ObjectContext{
		VaultID: service.vaultID, Kind: object.Kind, ObjectID: object.ObjectID, ObjectRevision: revision,
	}
}

func (service *Service) exceedsLimit(bytes int64) bool {
	return service.maximumCiphertextBytes != nil && bytes > *service.maximumCiphertextBytes
}

func encodeCiphertext(value cryptocontent.EnvelopeCiphertext) ([]byte, error) {
	if cryptocontent.ValidateEnvelopeCiphertext(value) != nil {
		return nil, ErrIntegrity
	}
	return json.Marshal(value)
}

func constantTimeEqual(left, right []byte) bool {
	return len(left) == len(right) && subtle.ConstantTimeCompare(left, right) == 1
}

func copyRevision(value *cryptocontent.ObjectRevision) *cryptocontent.ObjectRevision {
	if value == nil {
		return nil
	}
	copyOfValue := *value
	return &copyOfValue
}
