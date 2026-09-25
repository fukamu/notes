package operations

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrAccountDeletionAudit = errors.New("account deletion audit failed")

type AccountDeletionAuditQuery struct {
	AccountID  identity.AccountID
	VaultID    identity.VaultID
	ObservedAt int64
}

type AccountDeletionAuditRepository interface {
	FindByOwner(context.Context, accountdeletion.Scope) (*accountdeletion.Snapshot, error)
}

type AccountDeletionAuditResultKind string

const (
	AccountDeletionAuditInspected AccountDeletionAuditResultKind = "inspected"
	AccountDeletionAuditRefused   AccountDeletionAuditResultKind = "refused"
)

type AccountDeletionAuditRefusal string

const AccountDeletionAuditOwnerMismatch AccountDeletionAuditRefusal = "owner-mismatch"

type AccountDeletionAuditState string

const (
	AccountDeletionStepReady       AccountDeletionAuditState = "step-ready"
	AccountDeletionStepWaiting     AccountDeletionAuditState = "step-waiting"
	AccountDeletionStepRunning     AccountDeletionAuditState = "step-running"
	AccountDeletionLeaseExpired    AccountDeletionAuditState = "lease-expired"
	AccountDeletionRetryWaiting    AccountDeletionAuditState = "retry-waiting"
	AccountDeletionRetryDue        AccountDeletionAuditState = "retry-due"
	AccountDeletionTerminalFailure AccountDeletionAuditState = "terminal-failure"
	AccountDeletionCompleted       AccountDeletionAuditState = "completed"
)

type AccountDeletionAuditResult struct {
	Kind           AccountDeletionAuditResultKind
	Reason         AccountDeletionAuditRefusal
	OperationID    accountdeletion.OperationID
	State          AccountDeletionAuditState
	Step           accountdeletion.Step
	ReadyToAdvance bool
	RelevantAt     int64
	ObservedAt     int64
}

type AccountDeletionAuditService struct {
	repository AccountDeletionAuditRepository
}

func NewAccountDeletionAuditService(
	repository AccountDeletionAuditRepository,
) (*AccountDeletionAuditService, error) {
	if repository == nil {
		return nil, ErrAccountDeletionAudit
	}
	return &AccountDeletionAuditService{repository: repository}, nil
}

func (service *AccountDeletionAuditService) Inspect(
	ctx context.Context,
	query AccountDeletionAuditQuery,
) (AccountDeletionAuditResult, error) {
	if service == nil || service.repository == nil || ctx == nil ||
		ValidateAccountDeletionAuditQuery(query) != nil {
		return AccountDeletionAuditResult{}, ErrAccountDeletionAudit
	}
	scope := accountdeletion.Scope{AccountID: query.AccountID, VaultID: query.VaultID}
	snapshot, err := service.repository.FindByOwner(ctx, scope)
	if err != nil {
		return AccountDeletionAuditResult{}, err
	}
	if snapshot == nil {
		return AccountDeletionAuditResult{
			Kind: AccountDeletionAuditRefused, Reason: AccountDeletionAuditOwnerMismatch,
			ObservedAt: query.ObservedAt,
		}, nil
	}
	return PlanAccountDeletionAudit(query, *snapshot)
}

func ValidateAccountDeletionAuditQuery(query AccountDeletionAuditQuery) error {
	if _, err := identity.ParseAccountID(string(query.AccountID)); err != nil {
		return ErrAccountDeletionAudit
	}
	if _, err := identity.ParseVaultID(string(query.VaultID)); err != nil || !validTimestamp(query.ObservedAt) {
		return ErrAccountDeletionAudit
	}
	return nil
}

func PlanAccountDeletionAudit(
	query AccountDeletionAuditQuery,
	snapshot accountdeletion.Snapshot,
) (AccountDeletionAuditResult, error) {
	if ValidateAccountDeletionAuditQuery(query) != nil || !accountdeletion.ValidSnapshot(snapshot) ||
		snapshot.Operation.Scope.AccountID != query.AccountID || snapshot.Operation.Scope.VaultID != query.VaultID ||
		query.ObservedAt < snapshot.Operation.CreatedAt {
		return AccountDeletionAuditResult{}, ErrAccountDeletionAudit
	}
	result := AccountDeletionAuditResult{
		Kind: AccountDeletionAuditInspected, OperationID: snapshot.Operation.OperationID,
		ObservedAt: query.ObservedAt,
	}
	switch state := snapshot.Operation.State.(type) {
	case accountdeletion.Ready:
		result.Step = state.Step
		result.RelevantAt = state.NotBefore
		result.ReadyToAdvance = query.ObservedAt >= state.NotBefore
		result.State = AccountDeletionStepWaiting
		if result.ReadyToAdvance {
			result.State = AccountDeletionStepReady
		}
	case accountdeletion.Running:
		result.Step = state.Step
		result.RelevantAt = state.LeaseExpiresAt
		result.ReadyToAdvance = query.ObservedAt >= state.LeaseExpiresAt
		result.State = AccountDeletionStepRunning
		if result.ReadyToAdvance {
			result.State = AccountDeletionLeaseExpired
		}
	case accountdeletion.RetryWait:
		result.Step = state.Step
		result.RelevantAt = state.RetryAt
		result.ReadyToAdvance = query.ObservedAt >= state.RetryAt
		result.State = AccountDeletionRetryWaiting
		if result.ReadyToAdvance {
			result.State = AccountDeletionRetryDue
		}
	case accountdeletion.TerminalFailure:
		result.Step = state.Step
		result.RelevantAt = snapshot.Operation.UpdatedAt
		result.State = AccountDeletionTerminalFailure
	case accountdeletion.Completed:
		result.RelevantAt = state.CompletedAt
		result.State = AccountDeletionCompleted
	default:
		return AccountDeletionAuditResult{}, ErrAccountDeletionAudit
	}
	return result, nil
}
