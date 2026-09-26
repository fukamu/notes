package encryptedobject

import (
	"context"

	"github.com/fukamu/notes/backend/internal/identity"
)

const MaximumOrphanCollectionBatchSize = 100

type OrphanCollectionBatchResult struct {
	Enqueued int
	Pending  bool
}

type OrphanCollector struct {
	metadata MetadataRepository
	objects  ObjectStoragePort
}

func NewOrphanCollector(
	metadata MetadataRepository,
	objects ObjectStoragePort,
) (*OrphanCollector, error) {
	if metadata == nil || objects == nil {
		return nil, ErrInvalidOperation
	}
	return &OrphanCollector{metadata: metadata, objects: objects}, nil
}

func (collector *OrphanCollector) CollectBatch(
	ctx context.Context,
	scanStartedAt, gracePeriodMilli int64,
	limit int,
) (OrphanCollectionBatchResult, error) {
	if collector == nil || collector.metadata == nil || collector.objects == nil || ctx == nil ||
		!validTimestamp(scanStartedAt) || scanStartedAt == 0 || gracePeriodMilli < 0 ||
		gracePeriodMilli > identity.MaximumSafeInteger ||
		limit < 1 || limit > MaximumOrphanCollectionBatchSize {
		return OrphanCollectionBatchResult{}, ErrInvalidOperation
	}
	if err := ctx.Err(); err != nil {
		return OrphanCollectionBatchResult{}, err
	}
	stored, err := collector.objects.List(ctx)
	if err != nil {
		return OrphanCollectionBatchResult{}, err
	}
	protected, err := collector.metadata.ListProtectedObjectKeys(ctx)
	if err != nil {
		return OrphanCollectionBatchResult{}, err
	}
	candidates := PlanOrphanCollection(stored, protected, scanStartedAt, gracePeriodMilli)
	result := OrphanCollectionBatchResult{}
	for _, objectKey := range candidates {
		if err := ctx.Err(); err != nil {
			return OrphanCollectionBatchResult{}, err
		}
		if result.Enqueued == limit {
			result.Pending = true
			return result, nil
		}
		applied, enqueueErr := collector.metadata.EnqueueDelete(ctx, objectKey, scanStartedAt)
		if enqueueErr != nil {
			return OrphanCollectionBatchResult{}, enqueueErr
		}
		if applied {
			result.Enqueued++
		}
	}
	return result, nil
}
