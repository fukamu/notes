package vaultdata

import (
	"context"
	"errors"
	"regexp"

	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrInvalidConfiguration = errors.New("invalid Vault data purge configuration")

var operationIDPattern = regexp.MustCompile(
	`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
)

type OperationID string

func ParseOperationID(value string) (OperationID, error) {
	if !operationIDPattern.MatchString(value) {
		return "", ErrInvalidConfiguration
	}
	return OperationID(value), nil
}

type Scope struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
}

func (scope Scope) Valid() bool {
	_, accountErr := identity.ParseAccountID(string(scope.AccountID))
	_, vaultErr := identity.ParseVaultID(string(scope.VaultID))
	return accountErr == nil && vaultErr == nil
}

type PurgeCommand struct {
	Scope       Scope
	OperationID OperationID
	RequestedAt int64
}

type RepositoryResultKind string

const (
	RepositoryPurged           RepositoryResultKind = "purged"
	RepositoryAlreadyPurged    RepositoryResultKind = "already-purged"
	RepositoryIncomplete       RepositoryResultKind = "incomplete"
	RepositoryOwnerMismatch    RepositoryResultKind = "owner-mismatch"
	RepositoryIntegrityFailure RepositoryResultKind = "integrity-failure"
)

type RepositoryResult struct {
	Kind               RepositoryResultKind
	LiveRowsBefore     int64
	EnqueuedObjectKeys int64
}

type Repository interface {
	PurgeVaultData(context.Context, PurgeCommand) (RepositoryResult, error)
}

type PurgeResultKind string
type PurgeOutcome string
type PurgeFailureReason string

const (
	PurgeConfirmed        PurgeResultKind = "confirmed"
	PurgeRetryableFailure PurgeResultKind = "retryable-failure"
	PurgeTerminalFailure  PurgeResultKind = "terminal-failure"

	OutcomePurged        PurgeOutcome = "purged"
	OutcomeAlreadyPurged PurgeOutcome = "already-purged"

	FailureInvalidCommand        PurgeFailureReason = "invalid-command"
	FailureRepositoryUnavailable PurgeFailureReason = "repository-unavailable"
	FailureIncomplete            PurgeFailureReason = "incomplete"
	FailureOwnerMismatch         PurgeFailureReason = "owner-mismatch"
	FailureIntegrity             PurgeFailureReason = "integrity-failure"
	FailureMalformedResult       PurgeFailureReason = "malformed-result"
)

type PurgeResult struct {
	Kind    PurgeResultKind
	Outcome PurgeOutcome
	Reason  PurgeFailureReason
}

type PurgePort interface {
	Purge(context.Context, PurgeCommand) (PurgeResult, error)
}

type Service struct {
	repository Repository
}

func NewService(repository Repository) (*Service, error) {
	if repository == nil {
		return nil, ErrInvalidConfiguration
	}
	return &Service{repository: repository}, nil
}

func (service *Service) Purge(ctx context.Context, command PurgeCommand) (PurgeResult, error) {
	if service == nil || service.repository == nil {
		return PurgeResult{}, ErrInvalidConfiguration
	}
	if !ValidCommand(command) {
		return terminal(FailureInvalidCommand), nil
	}
	result, err := service.repository.PurgeVaultData(ctx, command)
	if err != nil {
		return retryable(FailureRepositoryUnavailable), nil
	}
	return EvaluateRepositoryResult(result), nil
}

func ValidCommand(command PurgeCommand) bool {
	if !command.Scope.Valid() || command.RequestedAt < 0 ||
		command.RequestedAt > identity.MaximumSafeInteger {
		return false
	}
	_, err := ParseOperationID(string(command.OperationID))
	return err == nil
}

func EvaluateRepositoryResult(result RepositoryResult) PurgeResult {
	if !ValidRepositoryResult(result) {
		return retryable(FailureMalformedResult)
	}
	switch result.Kind {
	case RepositoryPurged:
		return PurgeResult{Kind: PurgeConfirmed, Outcome: OutcomePurged}
	case RepositoryAlreadyPurged:
		return PurgeResult{Kind: PurgeConfirmed, Outcome: OutcomeAlreadyPurged}
	case RepositoryIncomplete:
		return retryable(FailureIncomplete)
	case RepositoryOwnerMismatch:
		return terminal(FailureOwnerMismatch)
	case RepositoryIntegrityFailure:
		return terminal(FailureIntegrity)
	default:
		return retryable(FailureMalformedResult)
	}
}

func ValidRepositoryResult(result RepositoryResult) bool {
	if result.LiveRowsBefore < 0 || result.LiveRowsBefore > identity.MaximumSafeInteger ||
		result.EnqueuedObjectKeys < 0 || result.EnqueuedObjectKeys > identity.MaximumSafeInteger {
		return false
	}
	switch result.Kind {
	case RepositoryPurged:
		return result.LiveRowsBefore > 0 && result.EnqueuedObjectKeys <= result.LiveRowsBefore
	case RepositoryAlreadyPurged:
		return result.LiveRowsBefore == 0 && result.EnqueuedObjectKeys == 0
	case RepositoryIncomplete, RepositoryIntegrityFailure:
		return result.EnqueuedObjectKeys <= result.LiveRowsBefore
	case RepositoryOwnerMismatch:
		return result.LiveRowsBefore == 0 && result.EnqueuedObjectKeys == 0
	default:
		return false
	}
}

func retryable(reason PurgeFailureReason) PurgeResult {
	return PurgeResult{Kind: PurgeRetryableFailure, Reason: reason}
}

func terminal(reason PurgeFailureReason) PurgeResult {
	return PurgeResult{Kind: PurgeTerminalFailure, Reason: reason}
}
