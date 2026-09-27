package encryptedobject

import (
	"context"

	"github.com/fukamu/notes/backend/internal/identity"
)

const MaximumDeleteOutboxBatchSize = 100

type DeleteOutboxDrainBatchResult struct {
	Completed int
	Retried   int
	Replayed  int
	Contended int
	Pending   bool
}

type DeleteOutboxDrainer struct {
	repository VaultObjectDeleteOutboxRepository
	objects    PrivateObjectDeletePort
}

func NewDeleteOutboxDrainer(
	repository VaultObjectDeleteOutboxRepository,
	objects PrivateObjectDeletePort,
) (*DeleteOutboxDrainer, error) {
	if repository == nil || objects == nil {
		return nil, ErrInvalidOperation
	}
	return &DeleteOutboxDrainer{repository: repository, objects: objects}, nil
}

func (drainer *DeleteOutboxDrainer) DrainBatch(
	ctx context.Context,
	attemptedAt, retryDelayMilli int64,
	limit int,
) (DeleteOutboxDrainBatchResult, error) {
	if drainer == nil || drainer.repository == nil || drainer.objects == nil || ctx == nil ||
		!validTimestamp(attemptedAt) || attemptedAt == 0 || retryDelayMilli < 0 ||
		retryDelayMilli > identity.MaximumSafeInteger ||
		attemptedAt > identity.MaximumSafeInteger-retryDelayMilli ||
		limit < 1 || limit > MaximumDeleteOutboxBatchSize {
		return DeleteOutboxDrainBatchResult{}, ErrInvalidOperation
	}
	if err := ctx.Err(); err != nil {
		return DeleteOutboxDrainBatchResult{}, err
	}
	entries, err := drainer.repository.ListReady(ctx, attemptedAt, limit)
	if err != nil {
		return DeleteOutboxDrainBatchResult{}, err
	}
	if len(entries) > limit {
		return DeleteOutboxDrainBatchResult{}, ErrInvalidOperation
	}
	seen := make(map[ObjectKey]struct{}, len(entries))
	for _, entry := range entries {
		if !ValidDeleteOutboxEntry(entry) || entry.NextAttemptAt > attemptedAt {
			return DeleteOutboxDrainBatchResult{}, ErrInvalidOperation
		}
		if _, duplicate := seen[entry.ObjectKey]; duplicate {
			return DeleteOutboxDrainBatchResult{}, ErrInvalidOperation
		}
		seen[entry.ObjectKey] = struct{}{}
	}

	result := DeleteOutboxDrainBatchResult{}
	for _, entry := range entries {
		if err := ctx.Err(); err != nil {
			return DeleteOutboxDrainBatchResult{}, err
		}
		deletion, deleteErr := drainer.objects.Delete(ctx, entry.ObjectKey)
		if err := ctx.Err(); err != nil {
			return DeleteOutboxDrainBatchResult{}, err
		}
		if deleteErr == nil && deletion != DeleteDeleted && deletion != DeleteNotFound {
			return DeleteOutboxDrainBatchResult{}, ErrInvalidOperation
		}
		succeeded := deleteErr == nil
		planned, complete := PlanDeleteAttempt(entry, succeeded, attemptedAt, retryDelayMilli)
		var mutation DeleteOutboxMutationResult
		if complete {
			mutation, err = drainer.repository.ConfirmDelete(ctx, entry)
		} else {
			if !ValidDeleteOutboxEntry(planned) {
				return DeleteOutboxDrainBatchResult{}, ErrInvalidOperation
			}
			mutation, err = drainer.repository.RescheduleDelete(ctx, planned)
		}
		if err != nil {
			return DeleteOutboxDrainBatchResult{}, err
		}
		switch mutation.Kind {
		case DeleteOutboxMutationApplied:
			if complete {
				result.Completed++
			} else {
				result.Retried++
			}
		case DeleteOutboxMutationReplayed:
			result.Replayed++
		case DeleteOutboxMutationConflict:
			result.Contended++
		default:
			return DeleteOutboxDrainBatchResult{}, ErrInvalidOperation
		}
	}
	pending, err := drainer.repository.CountPending(ctx)
	if err != nil {
		return DeleteOutboxDrainBatchResult{}, err
	}
	if pending < 0 || pending > identity.MaximumSafeInteger {
		return DeleteOutboxDrainBatchResult{}, ErrInvalidOperation
	}
	result.Pending = pending > 0
	return result, nil
}
