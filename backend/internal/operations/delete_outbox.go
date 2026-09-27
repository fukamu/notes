package operations

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrDeleteOutboxDrain = errors.New("delete outbox drain failed")

type DeleteOutboxScope struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
}

func (scope DeleteOutboxScope) Valid() bool {
	_, accountErr := identity.ParseAccountID(string(scope.AccountID))
	_, vaultErr := identity.ParseVaultID(string(scope.VaultID))
	return accountErr == nil && vaultErr == nil
}

type DeleteOutboxCommand struct {
	Scope           DeleteOutboxScope
	AttemptedAt     int64
	RetryDelayMilli int64
	Limit           int
}

type DeleteOutboxScopeLoader interface {
	OwnsDeleteOutboxScope(context.Context, DeleteOutboxCommand) (bool, error)
}

type DeleteOutboxBatchExecutor interface {
	DrainBatch(context.Context, int64, int64, int) (encryptedobject.DeleteOutboxDrainBatchResult, error)
}

type DeleteOutboxResultKind string

const (
	DeleteOutboxCompleted DeleteOutboxResultKind = "completed"
	DeleteOutboxPending   DeleteOutboxResultKind = "pending"
	DeleteOutboxRefused   DeleteOutboxResultKind = "refused"
)

type DeleteOutboxResult struct {
	Kind      DeleteOutboxResultKind
	Completed int
	Retried   int
	Replayed  int
	Contended int
}

type DeleteOutboxService struct {
	scope    DeleteOutboxScope
	loader   DeleteOutboxScopeLoader
	executor DeleteOutboxBatchExecutor
}

func NewDeleteOutboxService(
	scope DeleteOutboxScope,
	loader DeleteOutboxScopeLoader,
	executor DeleteOutboxBatchExecutor,
) (*DeleteOutboxService, error) {
	if !scope.Valid() || loader == nil || executor == nil {
		return nil, ErrDeleteOutboxDrain
	}
	return &DeleteOutboxService{scope: scope, loader: loader, executor: executor}, nil
}

func (service *DeleteOutboxService) Run(
	ctx context.Context,
	command DeleteOutboxCommand,
) (DeleteOutboxResult, error) {
	if service == nil || !service.scope.Valid() || service.loader == nil || service.executor == nil ||
		ctx == nil || ValidateDeleteOutboxCommand(command) != nil {
		return DeleteOutboxResult{}, ErrDeleteOutboxDrain
	}
	if command.Scope != service.scope {
		return DeleteOutboxResult{Kind: DeleteOutboxRefused}, nil
	}
	owned, err := service.loader.OwnsDeleteOutboxScope(ctx, command)
	if err != nil {
		return DeleteOutboxResult{}, err
	}
	if !owned {
		return DeleteOutboxResult{Kind: DeleteOutboxRefused}, nil
	}
	batch, err := service.executor.DrainBatch(
		ctx,
		command.AttemptedAt,
		command.RetryDelayMilli,
		command.Limit,
	)
	if err != nil {
		return DeleteOutboxResult{}, err
	}
	if !validDeleteOutboxBatchResult(batch, command.Limit) {
		return DeleteOutboxResult{}, ErrDeleteOutboxDrain
	}
	kind := DeleteOutboxCompleted
	if batch.Pending {
		kind = DeleteOutboxPending
	}
	return DeleteOutboxResult{
		Kind: kind, Completed: batch.Completed, Retried: batch.Retried,
		Replayed: batch.Replayed, Contended: batch.Contended,
	}, nil
}

func ValidateDeleteOutboxCommand(command DeleteOutboxCommand) error {
	if !command.Scope.Valid() || command.AttemptedAt <= 0 ||
		command.AttemptedAt > identity.MaximumSafeInteger || command.RetryDelayMilli < 0 ||
		command.RetryDelayMilli > identity.MaximumSafeInteger ||
		command.AttemptedAt > identity.MaximumSafeInteger-command.RetryDelayMilli ||
		command.Limit < 1 || command.Limit > encryptedobject.MaximumDeleteOutboxBatchSize {
		return ErrDeleteOutboxDrain
	}
	return nil
}

func validDeleteOutboxBatchResult(
	result encryptedobject.DeleteOutboxDrainBatchResult,
	limit int,
) bool {
	if result.Completed < 0 || result.Retried < 0 || result.Replayed < 0 || result.Contended < 0 {
		return false
	}
	return result.Completed+result.Retried+result.Replayed+result.Contended <= limit
}
