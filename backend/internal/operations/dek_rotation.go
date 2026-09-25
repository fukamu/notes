package operations

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrDEKRotation = errors.New("DEK rotation failed")

type DEKRotationCommand struct {
	AccountID        identity.AccountID
	VaultID          identity.VaultID
	OperationID      cryptocontent.RotationOperationID
	RequestedAtMilli int64
	GeneratedAtMilli int64
	CompletedAtMilli int64
}

type DEKRotationExecutor interface {
	Start(
		context.Context,
		cryptocontent.RotationScope,
		cryptocontent.RotationOperationID,
		int64,
	) (cryptocontent.RotationRunResult, error)
	Resume(
		context.Context,
		cryptocontent.RotationScope,
		cryptocontent.RotationOperationID,
		int64,
	) (cryptocontent.RotationRunResult, error)
}

type DEKRotationResultKind string

const (
	DEKRotationCompleted DEKRotationResultKind = "completed"
	DEKRotationReplayed  DEKRotationResultKind = "replayed"
	DEKRotationRefused   DEKRotationResultKind = "refused"
)

type DEKRotationResult struct {
	Kind        DEKRotationResultKind
	OperationID cryptocontent.RotationOperationID
	Reason      cryptocontent.RotationRunRejection
}

type DEKRotationService struct {
	executor DEKRotationExecutor
}

func NewDEKRotationService(executor DEKRotationExecutor) (*DEKRotationService, error) {
	if executor == nil {
		return nil, ErrDEKRotation
	}
	return &DEKRotationService{executor: executor}, nil
}

func (service *DEKRotationService) Run(
	ctx context.Context,
	command DEKRotationCommand,
) (DEKRotationResult, error) {
	if service == nil || service.executor == nil || ctx == nil || ValidateDEKRotationCommand(command) != nil {
		return DEKRotationResult{}, ErrDEKRotation
	}
	scope := cryptocontent.RotationScope{AccountID: command.AccountID, VaultID: command.VaultID}
	current, err := service.executor.Start(ctx, scope, command.OperationID, command.RequestedAtMilli)
	if err != nil {
		return DEKRotationResult{}, err
	}
	if result, done, mapErr := mapDEKRotationStart(command, current); done {
		return result, mapErr
	}

	if _, generating := current.Operation.State.(cryptocontent.RotationGenerating); generating {
		current, err = service.executor.Resume(ctx, scope, command.OperationID, command.GeneratedAtMilli)
		if err != nil {
			return DEKRotationResult{}, err
		}
		if result, done, mapErr := mapDEKRotationPending(command, current); done {
			return result, mapErr
		}
	}
	if _, promoting := current.Operation.State.(cryptocontent.RotationPromoting); !promoting {
		return DEKRotationResult{}, ErrDEKRotation
	}
	current, err = service.executor.Resume(ctx, scope, command.OperationID, command.CompletedAtMilli)
	if err != nil {
		return DEKRotationResult{}, err
	}
	switch current.Kind {
	case cryptocontent.RotationFinished:
		if !matchingDEKRotationOperation(command, current.Operation) {
			return DEKRotationResult{}, ErrDEKRotation
		}
		return DEKRotationResult{Kind: DEKRotationCompleted, OperationID: command.OperationID}, nil
	case cryptocontent.RotationRunReject:
		return refusedDEKRotation(command, current.Reason), nil
	default:
		return DEKRotationResult{}, ErrDEKRotation
	}
}

func ValidateDEKRotationCommand(command DEKRotationCommand) error {
	if _, err := identity.ParseAccountID(string(command.AccountID)); err != nil {
		return ErrDEKRotation
	}
	if _, err := identity.ParseVaultID(string(command.VaultID)); err != nil {
		return ErrDEKRotation
	}
	if _, err := cryptocontent.ParseRotationOperationID(string(command.OperationID)); err != nil {
		return ErrDEKRotation
	}
	if command.RequestedAtMilli <= 0 || command.GeneratedAtMilli < command.RequestedAtMilli ||
		command.CompletedAtMilli < command.GeneratedAtMilli ||
		command.CompletedAtMilli > cryptocontent.MaximumSafeInteger {
		return ErrDEKRotation
	}
	return nil
}

func mapDEKRotationStart(
	command DEKRotationCommand,
	result cryptocontent.RotationRunResult,
) (DEKRotationResult, bool, error) {
	switch result.Kind {
	case cryptocontent.RotationFinished:
		if !matchingDEKRotationOperation(command, result.Operation) {
			return DEKRotationResult{}, true, ErrDEKRotation
		}
		return DEKRotationResult{Kind: DEKRotationReplayed, OperationID: command.OperationID}, true, nil
	case cryptocontent.RotationRunReject:
		return refusedDEKRotation(command, result.Reason), true, nil
	case cryptocontent.RotationPending:
		if !matchingDEKRotationOperation(command, result.Operation) {
			return DEKRotationResult{}, true, ErrDEKRotation
		}
		return DEKRotationResult{}, false, nil
	default:
		return DEKRotationResult{}, true, ErrDEKRotation
	}
}

func mapDEKRotationPending(
	command DEKRotationCommand,
	result cryptocontent.RotationRunResult,
) (DEKRotationResult, bool, error) {
	switch result.Kind {
	case cryptocontent.RotationFinished:
		if !matchingDEKRotationOperation(command, result.Operation) {
			return DEKRotationResult{}, true, ErrDEKRotation
		}
		return DEKRotationResult{Kind: DEKRotationReplayed, OperationID: command.OperationID}, true, nil
	case cryptocontent.RotationRunReject:
		return refusedDEKRotation(command, result.Reason), true, nil
	case cryptocontent.RotationPending:
		if !matchingDEKRotationOperation(command, result.Operation) {
			return DEKRotationResult{}, true, ErrDEKRotation
		}
		return DEKRotationResult{}, false, nil
	default:
		return DEKRotationResult{}, true, ErrDEKRotation
	}
}

func matchingDEKRotationOperation(
	command DEKRotationCommand,
	operation *cryptocontent.RotationOperation,
) bool {
	return operation != nil && operation.AccountID == command.AccountID && operation.VaultID == command.VaultID &&
		operation.OperationID == command.OperationID && cryptocontent.ValidateRotationOperation(*operation) == nil
}

func refusedDEKRotation(
	command DEKRotationCommand,
	reason cryptocontent.RotationRunRejection,
) DEKRotationResult {
	return DEKRotationResult{Kind: DEKRotationRefused, OperationID: command.OperationID, Reason: reason}
}
