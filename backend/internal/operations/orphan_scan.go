package operations

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrOrphanScan = errors.New("orphan scan failed")

type OrphanScanCommand struct {
	AccountID        identity.AccountID
	VaultID          identity.VaultID
	ScanStartedAt    int64
	GracePeriodMilli int64
	Limit            int
}

type OrphanScanScopeLoader interface {
	OwnsOrphanScanScope(context.Context, OrphanScanCommand) (bool, error)
}

type OrphanScanBatchExecutor interface {
	CollectBatch(context.Context, int64, int64, int) (encryptedobject.OrphanCollectionBatchResult, error)
}

type OrphanScanResultKind string

const (
	OrphanScanCompleted OrphanScanResultKind = "completed"
	OrphanScanPending   OrphanScanResultKind = "pending"
	OrphanScanRefused   OrphanScanResultKind = "refused"
)

type OrphanScanResult struct {
	Kind     OrphanScanResultKind
	Enqueued int
}

type OrphanScanService struct {
	loader   OrphanScanScopeLoader
	executor OrphanScanBatchExecutor
}

func NewOrphanScanService(
	loader OrphanScanScopeLoader,
	executor OrphanScanBatchExecutor,
) (*OrphanScanService, error) {
	if loader == nil || executor == nil {
		return nil, ErrOrphanScan
	}
	return &OrphanScanService{loader: loader, executor: executor}, nil
}

func (service *OrphanScanService) Run(
	ctx context.Context,
	command OrphanScanCommand,
) (OrphanScanResult, error) {
	if service == nil || service.loader == nil || service.executor == nil || ctx == nil ||
		ValidateOrphanScanCommand(command) != nil {
		return OrphanScanResult{}, ErrOrphanScan
	}
	owned, err := service.loader.OwnsOrphanScanScope(ctx, command)
	if err != nil {
		return OrphanScanResult{}, err
	}
	if !owned {
		return OrphanScanResult{Kind: OrphanScanRefused}, nil
	}
	batch, err := service.executor.CollectBatch(
		ctx,
		command.ScanStartedAt,
		command.GracePeriodMilli,
		command.Limit,
	)
	if err != nil {
		return OrphanScanResult{}, err
	}
	if batch.Enqueued < 0 || batch.Enqueued > command.Limit || (batch.Pending && batch.Enqueued != command.Limit) {
		return OrphanScanResult{}, ErrOrphanScan
	}
	kind := OrphanScanCompleted
	if batch.Pending {
		kind = OrphanScanPending
	}
	return OrphanScanResult{Kind: kind, Enqueued: batch.Enqueued}, nil
}

func ValidateOrphanScanCommand(command OrphanScanCommand) error {
	if _, err := identity.ParseAccountID(string(command.AccountID)); err != nil {
		return ErrOrphanScan
	}
	if _, err := identity.ParseVaultID(string(command.VaultID)); err != nil {
		return ErrOrphanScan
	}
	if command.ScanStartedAt <= 0 || command.ScanStartedAt > identity.MaximumSafeInteger ||
		command.GracePeriodMilli < 0 || command.GracePeriodMilli > identity.MaximumSafeInteger ||
		command.Limit < 1 || command.Limit > encryptedobject.MaximumOrphanCollectionBatchSize {
		return ErrOrphanScan
	}
	return nil
}
