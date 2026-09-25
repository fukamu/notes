package encryptedobject

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrReencryption = errors.New("encrypted object re-encryption failed")

type ReencryptionCommitKind string

const (
	ReencryptionApplied  ReencryptionCommitKind = "applied"
	ReencryptionReplayed ReencryptionCommitKind = "replayed"
	ReencryptionConflict ReencryptionCommitKind = "conflict"
)

type ReencryptionCommitResult struct {
	Kind ReencryptionCommitKind
	Job  *ReencryptionJob
}

type ReencryptionRepository interface {
	LoadOrStartJob(context.Context, cryptocontent.DEKVersion, int64) (ReencryptionJob, error)
	Inventory(context.Context, cryptocontent.DEKVersion) (ReencryptionInventory, error)
	ListCandidates(context.Context, cryptocontent.DEKVersion, *ReencryptionPosition, int) ([]Metadata, error)
	CommitReplacement(context.Context, Metadata, Metadata, ReencryptionJob, ReencryptionJob, int64) (ReencryptionCommitResult, error)
	UpdateJob(context.Context, ReencryptionJob, ReencryptionJob) (ReencryptionCommitResult, error)
}

type ReencryptionBatchKind string

const (
	ReencryptionBatchCompleted ReencryptionBatchKind = "completed"
	ReencryptionBatchPending   ReencryptionBatchKind = "pending"
	ReencryptionBatchRejected  ReencryptionBatchKind = "rejected"
)

type ReencryptionPendingReason string

const (
	ReencryptionPageLimit     ReencryptionPendingReason = "page-limit"
	ReencryptionRestartScan   ReencryptionPendingReason = "restart-scan"
	ReencryptionCASConflict   ReencryptionPendingReason = "cas-conflict"
	ReencryptionPendingWrites ReencryptionPendingReason = "pending-writes"
)

type ReencryptionBatchResult struct {
	Kind      ReencryptionBatchKind
	Processed int
	Job       *ReencryptionJob
	Pending   ReencryptionPendingReason
	Rejected  ReencryptionRejection
}

type ReencryptionService struct {
	vaultID    identity.VaultID
	repository ReencryptionRepository
	objects    ObjectStoragePort
	objectKeys ObjectKeyGeneratorPort
	encryption EncryptionPort
}

func NewReencryptionService(
	vaultID identity.VaultID,
	repository ReencryptionRepository,
	objects ObjectStoragePort,
	objectKeys ObjectKeyGeneratorPort,
	encryption EncryptionPort,
) (*ReencryptionService, error) {
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil || repository == nil || objects == nil ||
		objectKeys == nil || encryption == nil {
		return nil, ErrReencryption
	}
	return &ReencryptionService{
		vaultID: vaultID, repository: repository, objects: objects,
		objectKeys: objectKeys, encryption: encryption,
	}, nil
}

func (service *ReencryptionService) RunBatch(
	ctx context.Context,
	keyring cryptocontent.VaultDEKKeyring,
	limit int,
	performedAtMilli int64,
) (ReencryptionBatchResult, error) {
	if service == nil || service.repository == nil || service.objects == nil || service.objectKeys == nil ||
		service.encryption == nil || limit < 1 || limit > MaximumReencryptionBatchSize ||
		!validTimestamp(performedAtMilli) {
		return ReencryptionBatchResult{}, ErrReencryption
	}
	if _, err := keyring.SelectForWrite(service.vaultID); err != nil {
		return rejectedReencryption(ReencryptionVaultMismatch), nil
	}
	job, err := service.repository.LoadOrStartJob(ctx, keyring.WriteVersion, performedAtMilli)
	if err != nil {
		return ReencryptionBatchResult{}, err
	}
	if ValidateReencryptionJob(job) != nil {
		return ReencryptionBatchResult{}, ErrReencryption
	}
	if job.TargetVersion != keyring.WriteVersion {
		return rejectedReencryption(ReencryptionTargetMismatch), nil
	}
	if job.State == ReencryptionCompleted {
		return completedReencryption(0, job), nil
	}

	initialInventory, err := service.repository.Inventory(ctx, job.TargetVersion)
	if err != nil {
		return ReencryptionBatchResult{}, err
	}
	initialPlan := EvaluateReencryptionInventory(initialInventory)
	switch initialPlan.Kind {
	case ReencryptionInventoryReject:
		return rejectedReencryption(initialPlan.Reason), nil
	case ReencryptionInventoryComplete:
		return service.finish(ctx, job, 0, performedAtMilli)
	case ReencryptionInventoryWait:
		return pendingReencryption(0, job, ReencryptionPendingWrites), nil
	case ReencryptionInventoryScan:
	default:
		return ReencryptionBatchResult{}, ErrReencryption
	}

	candidates, err := service.repository.ListCandidates(ctx, job.TargetVersion, copyPosition(job.After), limit)
	if err != nil {
		return ReencryptionBatchResult{}, err
	}
	if len(candidates) == 0 {
		next, planErr := AdvanceReencryptionJob(job, nil, ReencryptionRunning, performedAtMilli)
		if planErr != nil {
			return ReencryptionBatchResult{}, ErrReencryption
		}
		updated, updateErr := service.repository.UpdateJob(ctx, job, next)
		if updateErr != nil {
			return ReencryptionBatchResult{}, updateErr
		}
		return reencryptionUpdateResult(updated, 0, ReencryptionRestartScan)
	}
	if len(candidates) > limit {
		return ReencryptionBatchResult{}, ErrReencryption
	}
	SortReencryptionCandidates(candidates)
	var previous *ReencryptionPosition
	for _, candidate := range candidates {
		position := PositionFor(candidate)
		if (job.After != nil && CompareReencryptionPosition(position, *job.After) <= 0) ||
			(previous != nil && CompareReencryptionPosition(position, *previous) <= 0) {
			return ReencryptionBatchResult{}, ErrReencryption
		}
		copyOfPosition := position
		previous = &copyOfPosition
	}

	processed := 0
	currentJob := job
	for _, candidate := range candidates {
		if ValidateMetadata(candidate) != nil || candidate.DEKVersion >= currentJob.TargetVersion {
			return ReencryptionBatchResult{}, ErrReencryption
		}
		storedBytes, found, getErr := service.objects.Get(ctx, candidate.ObjectKey)
		if getErr != nil {
			return ReencryptionBatchResult{}, getErr
		}
		if !found || int64(len(storedBytes)) != candidate.CiphertextBytes {
			return ReencryptionBatchResult{}, ErrIntegrity
		}
		ciphertext, decodeErr := cryptocontent.DecodeEnvelopeCiphertext(storedBytes)
		if decodeErr != nil || !StoredCiphertextMatches(
			candidate.CryptoVersion, candidate.DEKVersion, &candidate.CiphertextBytes,
			ciphertext, int64(len(storedBytes)),
		) {
			return ReencryptionBatchResult{}, ErrIntegrity
		}
		objectContext := cryptocontent.ObjectContext{
			VaultID: service.vaultID, Kind: candidate.Object.Kind,
			ObjectID: candidate.Object.ObjectID, ObjectRevision: candidate.ObjectRevision,
		}
		plaintext, decryptErr := service.encryption.Decrypt(ctx, keyring, objectContext, ciphertext)
		if decryptErr != nil || int64(len(plaintext)) != candidate.PlaintextBytes {
			clear(plaintext)
			return ReencryptionBatchResult{}, ErrIntegrity
		}
		replacementCiphertext, encryptErr := service.encryption.Encrypt(ctx, keyring, objectContext, plaintext)
		clear(plaintext)
		if encryptErr != nil {
			return ReencryptionBatchResult{}, encryptErr
		}
		replacementBytes, encodeErr := encodeCiphertext(replacementCiphertext)
		if encodeErr != nil {
			return ReencryptionBatchResult{}, ErrIntegrity
		}
		rawObjectKey, keyErr := service.objectKeys.CreateObjectKey(ctx)
		if keyErr != nil {
			return ReencryptionBatchResult{}, keyErr
		}
		replacementObjectKey, parseErr := ParseObjectKey(rawObjectKey)
		if parseErr != nil {
			return ReencryptionBatchResult{}, ErrReencryption
		}
		candidatePlan := PlanReencryptionCandidate(
			candidate, currentJob.TargetVersion, replacementObjectKey, int64(len(replacementBytes)),
		)
		if !candidatePlan.Accepted || replacementCiphertext.DEKVersion != currentJob.TargetVersion {
			return ReencryptionBatchResult{}, ErrIntegrity
		}
		put, putErr := service.objects.PutIfAbsent(ctx, replacementObjectKey, replacementBytes, performedAtMilli)
		if putErr != nil {
			return ReencryptionBatchResult{}, putErr
		}
		switch put {
		case PutStored:
		case PutAlreadyPresent:
			existing, exists, readErr := service.objects.Get(ctx, replacementObjectKey)
			if readErr != nil {
				return ReencryptionBatchResult{}, readErr
			}
			if !exists || !constantTimeEqual(existing, replacementBytes) {
				return ReencryptionBatchResult{}, ErrStorageConflict
			}
		case PutConflict:
			return ReencryptionBatchResult{}, ErrStorageConflict
		default:
			return ReencryptionBatchResult{}, ErrReencryption
		}

		position := PositionFor(candidate)
		nextJob, planErr := AdvanceReencryptionJob(
			currentJob, &position, ReencryptionRunning, performedAtMilli,
		)
		if planErr != nil {
			return ReencryptionBatchResult{}, ErrReencryption
		}
		commit, commitErr := service.repository.CommitReplacement(
			ctx, candidate, candidatePlan.Replacement, currentJob, nextJob, performedAtMilli,
		)
		if commitErr != nil {
			return ReencryptionBatchResult{}, commitErr
		}
		switch commit.Kind {
		case ReencryptionApplied, ReencryptionReplayed:
			if commit.Job == nil || ValidateReencryptionJob(*commit.Job) != nil {
				return ReencryptionBatchResult{}, ErrReencryption
			}
			currentJob = *commit.Job
			processed++
		case ReencryptionConflict:
			return pendingReencryption(processed, currentJob, ReencryptionCASConflict), nil
		default:
			return ReencryptionBatchResult{}, ErrReencryption
		}
	}

	finalInventory, err := service.repository.Inventory(ctx, currentJob.TargetVersion)
	if err != nil {
		return ReencryptionBatchResult{}, err
	}
	finalPlan := EvaluateReencryptionInventory(finalInventory)
	switch finalPlan.Kind {
	case ReencryptionInventoryReject:
		result := rejectedReencryption(finalPlan.Reason)
		result.Processed = processed
		return result, nil
	case ReencryptionInventoryComplete:
		return service.finish(ctx, currentJob, processed, performedAtMilli)
	case ReencryptionInventoryWait:
		return pendingReencryption(processed, currentJob, ReencryptionPendingWrites), nil
	case ReencryptionInventoryScan:
		if len(candidates) < limit {
			next, planErr := AdvanceReencryptionJob(currentJob, nil, ReencryptionRunning, performedAtMilli)
			if planErr != nil {
				return ReencryptionBatchResult{}, ErrReencryption
			}
			updated, updateErr := service.repository.UpdateJob(ctx, currentJob, next)
			if updateErr != nil {
				return ReencryptionBatchResult{}, updateErr
			}
			return reencryptionUpdateResult(updated, processed, ReencryptionRestartScan)
		}
		return pendingReencryption(processed, currentJob, ReencryptionPageLimit), nil
	default:
		return ReencryptionBatchResult{}, ErrReencryption
	}
}

func (service *ReencryptionService) finish(
	ctx context.Context,
	job ReencryptionJob,
	processed int,
	performedAtMilli int64,
) (ReencryptionBatchResult, error) {
	next, err := AdvanceReencryptionJob(job, nil, ReencryptionCompleted, performedAtMilli)
	if err != nil {
		return ReencryptionBatchResult{}, ErrReencryption
	}
	updated, err := service.repository.UpdateJob(ctx, job, next)
	if err != nil {
		return ReencryptionBatchResult{}, err
	}
	switch updated.Kind {
	case ReencryptionApplied, ReencryptionReplayed:
		if updated.Job == nil || updated.Job.State != ReencryptionCompleted {
			return ReencryptionBatchResult{}, ErrReencryption
		}
		return completedReencryption(processed, *updated.Job), nil
	case ReencryptionConflict:
		return pendingReencryption(processed, job, ReencryptionCASConflict), nil
	default:
		return ReencryptionBatchResult{}, ErrReencryption
	}
}

func reencryptionUpdateResult(
	updated ReencryptionCommitResult,
	processed int,
	reason ReencryptionPendingReason,
) (ReencryptionBatchResult, error) {
	switch updated.Kind {
	case ReencryptionApplied, ReencryptionReplayed:
		if updated.Job == nil || ValidateReencryptionJob(*updated.Job) != nil {
			return ReencryptionBatchResult{}, ErrReencryption
		}
		return pendingReencryption(processed, *updated.Job, reason), nil
	case ReencryptionConflict:
		return ReencryptionBatchResult{
			Kind: ReencryptionBatchPending, Processed: processed, Pending: ReencryptionCASConflict,
		}, nil
	default:
		return ReencryptionBatchResult{}, ErrReencryption
	}
}

func copyPosition(value *ReencryptionPosition) *ReencryptionPosition {
	if value == nil {
		return nil
	}
	copyOfValue := *value
	return &copyOfValue
}

func completedReencryption(processed int, job ReencryptionJob) ReencryptionBatchResult {
	copyOfJob := job
	copyOfJob.After = copyPosition(job.After)
	return ReencryptionBatchResult{Kind: ReencryptionBatchCompleted, Processed: processed, Job: &copyOfJob}
}

func pendingReencryption(processed int, job ReencryptionJob, reason ReencryptionPendingReason) ReencryptionBatchResult {
	copyOfJob := job
	copyOfJob.After = copyPosition(job.After)
	return ReencryptionBatchResult{
		Kind: ReencryptionBatchPending, Processed: processed, Job: &copyOfJob, Pending: reason,
	}
}

func rejectedReencryption(reason ReencryptionRejection) ReencryptionBatchResult {
	return ReencryptionBatchResult{Kind: ReencryptionBatchRejected, Rejected: reason}
}
