package encryptedobject

import (
	"context"
	"errors"
	"regexp"

	"github.com/fukamu/notes/backend/internal/identity"
)

const MaximumDeleteAttempt = int64(2_147_483_647)

var (
	ErrInvalidVaultPrivateObjectPurge = errors.New("invalid Vault private-object purge configuration")
	purgeOperationIDPattern           = regexp.MustCompile(
		`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
	)
)

type PurgeOperationID string

func ParsePurgeOperationID(value string) (PurgeOperationID, error) {
	if !purgeOperationIDPattern.MatchString(value) {
		return "", ErrInvalidVaultPrivateObjectPurge
	}
	return PurgeOperationID(value), nil
}

type VaultPrivateObjectPurgeScope struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
}

func (scope VaultPrivateObjectPurgeScope) Valid() bool {
	_, accountErr := identity.ParseAccountID(string(scope.AccountID))
	_, vaultErr := identity.ParseVaultID(string(scope.VaultID))
	return accountErr == nil && vaultErr == nil
}

type VaultPrivateObjectPurgeCommand struct {
	Scope             VaultPrivateObjectPurgeScope
	OperationID       PurgeOperationID
	PreviousReceiptAt int64
	AttemptedAt       int64
}

func ValidVaultPrivateObjectPurgeCommand(command VaultPrivateObjectPurgeCommand) bool {
	if !command.Scope.Valid() || !validTimestamp(command.PreviousReceiptAt) ||
		!validTimestamp(command.AttemptedAt) || command.AttemptedAt < command.PreviousReceiptAt {
		return false
	}
	_, err := ParsePurgeOperationID(string(command.OperationID))
	return err == nil
}

type VaultPrivateObjectPurgePolicy struct {
	BatchLimit      int
	RetryDelayMilli int64
}

func ValidVaultPrivateObjectPurgePolicy(policy VaultPrivateObjectPurgePolicy) bool {
	return policy.BatchLimit >= 1 && policy.BatchLimit <= 100 &&
		policy.RetryDelayMilli >= 0 && policy.RetryDelayMilli <= identity.MaximumSafeInteger
}

type DeleteOutboxMutationKind string

const (
	DeleteOutboxMutationApplied  DeleteOutboxMutationKind = "applied"
	DeleteOutboxMutationReplayed DeleteOutboxMutationKind = "replayed"
	DeleteOutboxMutationConflict DeleteOutboxMutationKind = "conflict"
)

type DeleteOutboxMutationResult struct {
	Kind DeleteOutboxMutationKind
}

type VaultObjectDeleteOutboxRepository interface {
	CountPending(context.Context) (int64, error)
	ListReady(context.Context, int64, int) ([]DeleteOutboxEntry, error)
	ConfirmDelete(context.Context, DeleteOutboxEntry) (DeleteOutboxMutationResult, error)
	RescheduleDelete(context.Context, DeleteOutboxEntry) (DeleteOutboxMutationResult, error)
}

type DeleteOutboxOpenKind string

const (
	DeleteOutboxOpened           DeleteOutboxOpenKind = "opened"
	DeleteOutboxOwnerMismatch    DeleteOutboxOpenKind = "owner-mismatch"
	DeleteOutboxIntegrityFailure DeleteOutboxOpenKind = "integrity-failure"
)

type DeleteOutboxOpenResult struct {
	Kind       DeleteOutboxOpenKind
	Repository VaultObjectDeleteOutboxRepository
}

type VaultObjectDeleteOutboxDirectory interface {
	Open(context.Context, VaultPrivateObjectPurgeCommand) (DeleteOutboxOpenResult, error)
}

type PrivateObjectDeletePort interface {
	Delete(context.Context, ObjectKey) (DeleteResult, error)
}

type VaultPrivateObjectPurgeResultKind string
type VaultPrivateObjectPurgeOutcome string
type VaultPrivateObjectPurgeFailureReason string

const (
	VaultPrivateObjectPurgeConfirmed        VaultPrivateObjectPurgeResultKind = "confirmed"
	VaultPrivateObjectPurgeRetryableFailure VaultPrivateObjectPurgeResultKind = "retryable-failure"
	VaultPrivateObjectPurgeTerminalFailure  VaultPrivateObjectPurgeResultKind = "terminal-failure"

	VaultPrivateObjectPurgeDeleted      VaultPrivateObjectPurgeOutcome = "deleted"
	VaultPrivateObjectPurgeAlreadyEmpty VaultPrivateObjectPurgeOutcome = "already-empty"

	VaultPrivateObjectPurgeObjectsRemaining              VaultPrivateObjectPurgeFailureReason = "objects-remaining"
	VaultPrivateObjectPurgeStorageUnavailable            VaultPrivateObjectPurgeFailureReason = "storage-unavailable"
	VaultPrivateObjectPurgeOutboxUnavailable             VaultPrivateObjectPurgeFailureReason = "outbox-unavailable"
	VaultPrivateObjectPurgeDeleteConfirmationUnavailable VaultPrivateObjectPurgeFailureReason = "delete-confirmation-unavailable"
	VaultPrivateObjectPurgeOwnerMismatch                 VaultPrivateObjectPurgeFailureReason = "owner-mismatch"
	VaultPrivateObjectPurgeIntegrityFailure              VaultPrivateObjectPurgeFailureReason = "integrity-failure"
	VaultPrivateObjectPurgeInvalidCommand                VaultPrivateObjectPurgeFailureReason = "invalid-command"
)

type VaultPrivateObjectPurgeResult struct {
	Kind    VaultPrivateObjectPurgeResultKind
	Outcome VaultPrivateObjectPurgeOutcome
	Reason  VaultPrivateObjectPurgeFailureReason
}

type VaultPrivateObjectPurgePort interface {
	PurgeVaultPrivateObjects(context.Context, VaultPrivateObjectPurgeCommand) (VaultPrivateObjectPurgeResult, error)
}

type VaultPrivateObjectPurgeEvaluation struct {
	PendingBefore  int64
	Selected       int64
	Confirmed      int64
	StorageFailure int64
	PendingAfter   int64
}

func EvaluateVaultPrivateObjectPurge(value VaultPrivateObjectPurgeEvaluation) VaultPrivateObjectPurgeResult {
	if !validPurgeCount(value.PendingBefore) || !validPurgeCount(value.Selected) ||
		!validPurgeCount(value.Confirmed) || !validPurgeCount(value.StorageFailure) ||
		!validPurgeCount(value.PendingAfter) || value.Selected > value.PendingBefore ||
		value.PendingAfter > value.PendingBefore || value.Confirmed+value.StorageFailure != value.Selected {
		return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeDeleteConfirmationUnavailable)
	}
	if value.PendingAfter == 0 {
		outcome := VaultPrivateObjectPurgeDeleted
		if value.PendingBefore == 0 {
			outcome = VaultPrivateObjectPurgeAlreadyEmpty
		}
		return VaultPrivateObjectPurgeResult{Kind: VaultPrivateObjectPurgeConfirmed, Outcome: outcome}
	}
	if value.StorageFailure > 0 {
		return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeStorageUnavailable)
	}
	return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeObjectsRemaining)
}

type VaultPrivateObjectPurgeService struct {
	scope     VaultPrivateObjectPurgeScope
	directory VaultObjectDeleteOutboxDirectory
	objects   PrivateObjectDeletePort
	policy    VaultPrivateObjectPurgePolicy
}

func NewVaultPrivateObjectPurgeService(
	scope VaultPrivateObjectPurgeScope,
	directory VaultObjectDeleteOutboxDirectory,
	objects PrivateObjectDeletePort,
	policy VaultPrivateObjectPurgePolicy,
) (*VaultPrivateObjectPurgeService, error) {
	if !scope.Valid() || directory == nil || objects == nil || !ValidVaultPrivateObjectPurgePolicy(policy) {
		return nil, ErrInvalidVaultPrivateObjectPurge
	}
	return &VaultPrivateObjectPurgeService{
		scope: scope, directory: directory, objects: objects, policy: policy,
	}, nil
}

func (service *VaultPrivateObjectPurgeService) PurgeVaultPrivateObjects(
	ctx context.Context,
	command VaultPrivateObjectPurgeCommand,
) (VaultPrivateObjectPurgeResult, error) {
	if service == nil || service.directory == nil || service.objects == nil ||
		!ValidVaultPrivateObjectPurgePolicy(service.policy) {
		return VaultPrivateObjectPurgeResult{}, ErrInvalidVaultPrivateObjectPurge
	}
	if !ValidVaultPrivateObjectPurgeCommand(command) ||
		command.AttemptedAt > identity.MaximumSafeInteger-service.policy.RetryDelayMilli {
		return terminalVaultPrivateObjectPurge(VaultPrivateObjectPurgeInvalidCommand), nil
	}
	if command.Scope != service.scope {
		return terminalVaultPrivateObjectPurge(VaultPrivateObjectPurgeOwnerMismatch), nil
	}
	opened, err := service.directory.Open(ctx, command)
	if err != nil {
		return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeOutboxUnavailable), nil
	}
	var repository VaultObjectDeleteOutboxRepository
	switch opened.Kind {
	case DeleteOutboxOpened:
		if opened.Repository == nil {
			return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeOutboxUnavailable), nil
		}
		repository = opened.Repository
	case DeleteOutboxOwnerMismatch:
		return terminalVaultPrivateObjectPurge(VaultPrivateObjectPurgeOwnerMismatch), nil
	case DeleteOutboxIntegrityFailure:
		return terminalVaultPrivateObjectPurge(VaultPrivateObjectPurgeIntegrityFailure), nil
	default:
		return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeOutboxUnavailable), nil
	}

	pendingBefore, err := repository.CountPending(ctx)
	if err != nil || !validPurgeCount(pendingBefore) {
		return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeOutboxUnavailable), nil
	}
	if pendingBefore == 0 {
		return EvaluateVaultPrivateObjectPurge(VaultPrivateObjectPurgeEvaluation{}), nil
	}
	entries, err := repository.ListReady(ctx, command.AttemptedAt, service.policy.BatchLimit)
	if err != nil || int64(len(entries)) > pendingBefore {
		return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeOutboxUnavailable), nil
	}

	var confirmed, storageFailures int64
	for _, entry := range entries {
		if !ValidDeleteOutboxEntry(entry) {
			return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeDeleteConfirmationUnavailable), nil
		}
		deletion, deleteErr := service.objects.Delete(ctx, entry.ObjectKey)
		succeeded := deleteErr == nil && (deletion == DeleteDeleted || deletion == DeleteNotFound)
		planned, complete := PlanDeleteAttempt(entry, succeeded, command.AttemptedAt, service.policy.RetryDelayMilli)
		var mutation DeleteOutboxMutationResult
		if complete {
			mutation, err = repository.ConfirmDelete(ctx, entry)
		} else {
			storageFailures++
			if !ValidDeleteOutboxEntry(planned) {
				return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeDeleteConfirmationUnavailable), nil
			}
			mutation, err = repository.RescheduleDelete(ctx, planned)
		}
		if err != nil || (mutation.Kind != DeleteOutboxMutationApplied && mutation.Kind != DeleteOutboxMutationReplayed) {
			return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeDeleteConfirmationUnavailable), nil
		}
		if complete {
			confirmed++
		}
	}
	pendingAfter, err := repository.CountPending(ctx)
	if err != nil {
		return retryableVaultPrivateObjectPurge(VaultPrivateObjectPurgeOutboxUnavailable), nil
	}
	return EvaluateVaultPrivateObjectPurge(VaultPrivateObjectPurgeEvaluation{
		PendingBefore: pendingBefore, Selected: int64(len(entries)), Confirmed: confirmed,
		StorageFailure: storageFailures, PendingAfter: pendingAfter,
	}), nil
}

func ValidDeleteOutboxEntry(entry DeleteOutboxEntry) bool {
	if _, err := ParseObjectKey(string(entry.ObjectKey)); err != nil {
		return false
	}
	return entry.AttemptCount >= 0 && entry.AttemptCount <= MaximumDeleteAttempt &&
		validTimestamp(entry.NextAttemptAt) && validTimestamp(entry.CreatedAtMilli)
}

func validPurgeCount(value int64) bool {
	return value >= 0 && value <= identity.MaximumSafeInteger
}

func retryableVaultPrivateObjectPurge(reason VaultPrivateObjectPurgeFailureReason) VaultPrivateObjectPurgeResult {
	return VaultPrivateObjectPurgeResult{Kind: VaultPrivateObjectPurgeRetryableFailure, Reason: reason}
}

func terminalVaultPrivateObjectPurge(reason VaultPrivateObjectPurgeFailureReason) VaultPrivateObjectPurgeResult {
	return VaultPrivateObjectPurgeResult{Kind: VaultPrivateObjectPurgeTerminalFailure, Reason: reason}
}
