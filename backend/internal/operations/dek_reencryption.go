package operations

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrDEKReencryption = errors.New("DEK re-encryption failed")

type DEKReencryptionCommand struct {
	AccountID        identity.AccountID
	VaultID          identity.VaultID
	TargetVersion    cryptocontent.DEKVersion
	Limit            int
	PerformedAtMilli int64
}

type DEKReencryptionScopeLoad struct {
	Owned   bool
	Keyring *cryptocontent.VaultDEKKeyring
}

type DEKReencryptionScopeLoader interface {
	LoadDEKReencryptionScope(context.Context, DEKReencryptionCommand) (DEKReencryptionScopeLoad, error)
}

type DEKReencryptionBatchExecutor interface {
	RunBatch(
		context.Context,
		cryptocontent.VaultDEKKeyring,
		int,
		int64,
	) (encryptedobject.ReencryptionBatchResult, error)
}

type DEKReencryptionResultKind string

const (
	DEKReencryptionCompleted DEKReencryptionResultKind = "completed"
	DEKReencryptionPending   DEKReencryptionResultKind = "pending"
	DEKReencryptionRefused   DEKReencryptionResultKind = "refused"
)

type DEKReencryptionResult struct {
	Kind          DEKReencryptionResultKind
	Processed     int
	TargetVersion cryptocontent.DEKVersion
	Pending       encryptedobject.ReencryptionPendingReason
	Reason        encryptedobject.ReencryptionRejection
}

type DEKReencryptionService struct {
	loader   DEKReencryptionScopeLoader
	executor DEKReencryptionBatchExecutor
}

func NewDEKReencryptionService(
	loader DEKReencryptionScopeLoader,
	executor DEKReencryptionBatchExecutor,
) (*DEKReencryptionService, error) {
	if loader == nil || executor == nil {
		return nil, ErrDEKReencryption
	}
	return &DEKReencryptionService{loader: loader, executor: executor}, nil
}

func (service *DEKReencryptionService) Run(
	ctx context.Context,
	command DEKReencryptionCommand,
) (DEKReencryptionResult, error) {
	if service == nil || service.loader == nil || service.executor == nil || ctx == nil ||
		ValidateDEKReencryptionCommand(command) != nil {
		return DEKReencryptionResult{}, ErrDEKReencryption
	}
	loaded, err := service.loader.LoadDEKReencryptionScope(ctx, command)
	if err != nil {
		return DEKReencryptionResult{}, err
	}
	if !loaded.Owned {
		if loaded.Keyring != nil {
			return DEKReencryptionResult{}, ErrDEKReencryption
		}
		return DEKReencryptionResult{
			Kind: DEKReencryptionRefused, TargetVersion: command.TargetVersion,
			Reason: encryptedobject.ReencryptionOwnerMissing,
		}, nil
	}
	if loaded.Keyring == nil || loaded.Keyring.VaultID != command.VaultID ||
		loaded.Keyring.WriteVersion != command.TargetVersion {
		if loaded.Keyring != nil && loaded.Keyring.VaultID == command.VaultID &&
			cryptocontent.ValidateVaultDEKKeyring(*loaded.Keyring) == nil {
			return DEKReencryptionResult{
				Kind: DEKReencryptionRefused, TargetVersion: command.TargetVersion,
				Reason: encryptedobject.ReencryptionTargetMismatch,
			}, nil
		}
		return DEKReencryptionResult{}, ErrDEKReencryption
	}
	if cryptocontent.ValidateVaultDEKKeyring(*loaded.Keyring) != nil {
		return DEKReencryptionResult{}, ErrDEKReencryption
	}
	batch, err := service.executor.RunBatch(
		ctx,
		*loaded.Keyring,
		command.Limit,
		command.PerformedAtMilli,
	)
	if err != nil {
		return DEKReencryptionResult{}, err
	}
	return mapDEKReencryptionResult(command, batch)
}

func ValidateDEKReencryptionCommand(command DEKReencryptionCommand) error {
	if _, err := identity.ParseAccountID(string(command.AccountID)); err != nil {
		return ErrDEKReencryption
	}
	if _, err := identity.ParseVaultID(string(command.VaultID)); err != nil {
		return ErrDEKReencryption
	}
	if _, err := cryptocontent.ParseDEKVersion(int64(command.TargetVersion)); err != nil {
		return ErrDEKReencryption
	}
	if command.Limit < 1 || command.Limit > encryptedobject.MaximumReencryptionBatchSize ||
		command.PerformedAtMilli <= 0 || command.PerformedAtMilli > cryptocontent.MaximumSafeInteger {
		return ErrDEKReencryption
	}
	return nil
}

func mapDEKReencryptionResult(
	command DEKReencryptionCommand,
	batch encryptedobject.ReencryptionBatchResult,
) (DEKReencryptionResult, error) {
	if batch.Processed < 0 || batch.Processed > command.Limit {
		return DEKReencryptionResult{}, ErrDEKReencryption
	}
	result := DEKReencryptionResult{
		Processed: batch.Processed, TargetVersion: command.TargetVersion,
	}
	switch batch.Kind {
	case encryptedobject.ReencryptionBatchCompleted:
		if !matchingDEKReencryptionJob(command, batch.Job) || batch.Pending != "" || batch.Rejected != "" {
			return DEKReencryptionResult{}, ErrDEKReencryption
		}
		result.Kind = DEKReencryptionCompleted
		return result, nil
	case encryptedobject.ReencryptionBatchPending:
		jobMatches := matchingDEKReencryptionJob(command, batch.Job)
		concurrentConflict := batch.Pending == encryptedobject.ReencryptionCASConflict && batch.Job == nil
		if (!jobMatches && !concurrentConflict) || !validDEKReencryptionPending(batch.Pending) || batch.Rejected != "" {
			return DEKReencryptionResult{}, ErrDEKReencryption
		}
		result.Kind = DEKReencryptionPending
		result.Pending = batch.Pending
		return result, nil
	case encryptedobject.ReencryptionBatchRejected:
		if batch.Job != nil || batch.Pending != "" || !validDEKReencryptionRejection(batch.Rejected) {
			return DEKReencryptionResult{}, ErrDEKReencryption
		}
		result.Kind = DEKReencryptionRefused
		result.Reason = batch.Rejected
		return result, nil
	default:
		return DEKReencryptionResult{}, ErrDEKReencryption
	}
}

func matchingDEKReencryptionJob(
	command DEKReencryptionCommand,
	job *encryptedobject.ReencryptionJob,
) bool {
	return job != nil && job.TargetVersion == command.TargetVersion &&
		encryptedobject.ValidateReencryptionJob(*job) == nil
}

func validDEKReencryptionPending(reason encryptedobject.ReencryptionPendingReason) bool {
	switch reason {
	case encryptedobject.ReencryptionPageLimit,
		encryptedobject.ReencryptionRestartScan,
		encryptedobject.ReencryptionCASConflict,
		encryptedobject.ReencryptionPendingWrites:
		return true
	default:
		return false
	}
}

func validDEKReencryptionRejection(reason encryptedobject.ReencryptionRejection) bool {
	switch reason {
	case encryptedobject.ReencryptionVaultMismatch,
		encryptedobject.ReencryptionOwnerMissing,
		encryptedobject.ReencryptionBadInventory,
		encryptedobject.ReencryptionNewerVersion,
		encryptedobject.ReencryptionTargetMismatch:
		return true
	default:
		return false
	}
}
