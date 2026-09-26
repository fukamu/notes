package operations

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrRecoveryDrill = errors.New("recovery drill failed")

type RecoveryDrillCommand struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
	DrilledAt int64
}

type RecoveryDrillExecutor interface {
	Run(context.Context, encryptedobject.RecoveryScope, int64) encryptedobject.RecoveryDrillResult
}

type RecoveryDrillResultKind string

const (
	RecoveryDrillVerified RecoveryDrillResultKind = "verified"
	RecoveryDrillBlocked  RecoveryDrillResultKind = "blocked"
)

type RecoveryDrillResult struct {
	Kind             RecoveryDrillResultKind
	Reason           encryptedobject.RecoveryDrillResultReason
	SourceVersion    cryptocontent.DEKVersion
	TargetVersion    cryptocontent.DEKVersion
	ObjectCount      int64
	VerifiedVersions int
}

type RecoveryDrillService struct {
	executor RecoveryDrillExecutor
}

func NewRecoveryDrillService(executor RecoveryDrillExecutor) (*RecoveryDrillService, error) {
	if executor == nil {
		return nil, ErrRecoveryDrill
	}
	return &RecoveryDrillService{executor: executor}, nil
}

func (service *RecoveryDrillService) Run(
	ctx context.Context,
	command RecoveryDrillCommand,
) (RecoveryDrillResult, error) {
	if service == nil || service.executor == nil || ctx == nil || ValidateRecoveryDrillCommand(command) != nil {
		return RecoveryDrillResult{}, ErrRecoveryDrill
	}
	if err := ctx.Err(); err != nil {
		return RecoveryDrillResult{}, err
	}
	scope := encryptedobject.RecoveryScope{AccountID: command.AccountID, VaultID: command.VaultID}
	result := service.executor.Run(ctx, scope, command.DrilledAt)
	if err := ctx.Err(); err != nil {
		return RecoveryDrillResult{}, err
	}
	switch result.Kind {
	case encryptedobject.RecoveryResultBlocked:
		if result.Receipt != nil || !validRecoveryDrillReason(result.Reason) {
			return RecoveryDrillResult{}, ErrRecoveryDrill
		}
		return RecoveryDrillResult{Kind: RecoveryDrillBlocked, Reason: result.Reason}, nil
	case encryptedobject.RecoveryResultVerified:
		if result.Reason != "" || result.Receipt == nil || result.Receipt.AccountID != command.AccountID ||
			result.Receipt.VaultID != command.VaultID || result.Receipt.DrilledAt != command.DrilledAt ||
			encryptedobject.ValidateRecoveryDrillReceipt(*result.Receipt) != nil {
			return RecoveryDrillResult{}, ErrRecoveryDrill
		}
		mapped := RecoveryDrillResult{
			Kind: RecoveryDrillVerified, SourceVersion: result.Receipt.SourceVersion,
			TargetVersion: result.Receipt.TargetVersion, ObjectCount: result.Receipt.ObjectCount,
			VerifiedVersions: len(result.Receipt.VerifiedVersions),
		}
		if !ValidRecoveryDrillResult(mapped) {
			return RecoveryDrillResult{}, ErrRecoveryDrill
		}
		return mapped, nil
	default:
		return RecoveryDrillResult{}, ErrRecoveryDrill
	}
}

func ValidRecoveryDrillResult(result RecoveryDrillResult) bool {
	switch result.Kind {
	case RecoveryDrillBlocked:
		return validRecoveryDrillReason(result.Reason) && result.SourceVersion == 0 &&
			result.TargetVersion == 0 && result.ObjectCount == 0 && result.VerifiedVersions == 0
	case RecoveryDrillVerified:
		_, sourceErr := cryptocontent.ParseDEKVersion(int64(result.SourceVersion))
		_, targetErr := cryptocontent.ParseDEKVersion(int64(result.TargetVersion))
		return result.Reason == "" && sourceErr == nil && targetErr == nil &&
			result.TargetVersion > result.SourceVersion && result.ObjectCount >= 0 &&
			result.ObjectCount <= encryptedobject.MaximumRecoveryObjects && result.VerifiedVersions >= 0 &&
			result.VerifiedVersions <= cryptocontent.MaximumKeyringSize
	default:
		return false
	}
}

func ValidateRecoveryDrillCommand(command RecoveryDrillCommand) error {
	if _, err := identity.ParseAccountID(string(command.AccountID)); err != nil {
		return ErrRecoveryDrill
	}
	if _, err := identity.ParseVaultID(string(command.VaultID)); err != nil || !validTimestamp(command.DrilledAt) {
		return ErrRecoveryDrill
	}
	return nil
}

func validRecoveryDrillReason(reason encryptedobject.RecoveryDrillResultReason) bool {
	switch reason {
	case encryptedobject.RecoveryInvalidManifest,
		encryptedobject.RecoveryBackupUnavailable,
		encryptedobject.RecoveryResultScopeMismatch,
		encryptedobject.RecoveryResultInvalidTime,
		encryptedobject.RecoveryResultExpired,
		encryptedobject.RecoveryResultRotation,
		encryptedobject.RecoveryResultCheckpoint,
		encryptedobject.RecoveryMissingObject,
		encryptedobject.RecoveryInvalidCiphertext,
		encryptedobject.RecoveryAuthenticationFailed,
		encryptedobject.RecoveryResultInvalidEvidence:
		return true
	default:
		return false
	}
}
