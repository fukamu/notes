package operations

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/stripebilling"
)

var ErrBillingReconciliation = errors.New("billing reconciliation failed")

type BillingReconciliationCommand struct {
	AccountID  identity.AccountID
	VaultID    identity.VaultID
	SnapshotID billing.ReconciliationSnapshotID
	ObservedAt int64
	RecordedAt int64
}

type BillingReconciliationRepository interface {
	FindByOwner(context.Context, billing.OwnerScope) (*billing.SubscriptionRecord, error)
	FindReconciliationCheckpoint(
		context.Context,
		billing.Provider,
		billing.ReconciliationSnapshotID,
	) (*billing.ReconciliationCheckpoint, error)
}

type BillingReconciliationExecutor interface {
	ReconcileSubscription(context.Context, stripebilling.ReconciliationCommand) stripebilling.WebhookResult
}

type BillingReconciliationPlanKind string

const (
	BillingReconciliationPlanExecute BillingReconciliationPlanKind = "execute"
	BillingReconciliationPlanReplay  BillingReconciliationPlanKind = "replay"
	BillingReconciliationPlanRefuse  BillingReconciliationPlanKind = "refuse"
)

type BillingReconciliationRefusal string

const (
	BillingReconciliationInvalidInput       BillingReconciliationRefusal = "invalid-input"
	BillingReconciliationOwnerMismatch      BillingReconciliationRefusal = "owner-mismatch"
	BillingReconciliationInvalidStoredState BillingReconciliationRefusal = "invalid-stored-state"
	BillingReconciliationProviderNotLinked  BillingReconciliationRefusal = "provider-not-linked"
	BillingReconciliationSnapshotConflict   BillingReconciliationRefusal = "snapshot-conflict"
)

type BillingReconciliationPlan struct {
	Kind    BillingReconciliationPlanKind
	Reason  BillingReconciliationRefusal
	Command stripebilling.ReconciliationCommand
}

type BillingReconciliationResultKind string

const (
	BillingReconciliationApplied  BillingReconciliationResultKind = "applied"
	BillingReconciliationIgnored  BillingReconciliationResultKind = "ignored"
	BillingReconciliationReplayed BillingReconciliationResultKind = "replayed"
	BillingReconciliationRefused  BillingReconciliationResultKind = "refused"
)

type BillingReconciliationResult struct {
	Kind       BillingReconciliationResultKind
	Reason     BillingReconciliationRefusal
	SnapshotID billing.ReconciliationSnapshotID
	ObservedAt int64
	RecordedAt int64
}

type BillingReconciliationService struct {
	repository BillingReconciliationRepository
	executor   BillingReconciliationExecutor
}

func NewBillingReconciliationService(
	repository BillingReconciliationRepository,
	executor BillingReconciliationExecutor,
) (*BillingReconciliationService, error) {
	if repository == nil || executor == nil {
		return nil, ErrBillingReconciliation
	}
	return &BillingReconciliationService{repository: repository, executor: executor}, nil
}

func (service *BillingReconciliationService) Reconcile(
	ctx context.Context,
	command BillingReconciliationCommand,
) (BillingReconciliationResult, error) {
	if service == nil || service.repository == nil || service.executor == nil || ctx == nil ||
		ValidateBillingReconciliationCommand(command) != nil {
		return BillingReconciliationResult{}, ErrBillingReconciliation
	}
	scope := billing.OwnerScope{AccountID: command.AccountID, VaultID: command.VaultID}
	record, err := service.repository.FindByOwner(ctx, scope)
	if err != nil {
		return BillingReconciliationResult{}, err
	}
	plan := PlanBillingReconciliation(command, record, nil)
	if plan.Kind == BillingReconciliationPlanRefuse {
		return refusedBillingReconciliation(command, plan.Reason), nil
	}
	checkpoint, err := service.repository.FindReconciliationCheckpoint(
		ctx, stripebilling.Provider, command.SnapshotID,
	)
	if err != nil {
		return BillingReconciliationResult{}, err
	}
	plan = PlanBillingReconciliation(command, record, checkpoint)
	switch plan.Kind {
	case BillingReconciliationPlanRefuse:
		return refusedBillingReconciliation(command, plan.Reason), nil
	case BillingReconciliationPlanReplay:
		return billingReconciliationResult(BillingReconciliationReplayed, command), nil
	case BillingReconciliationPlanExecute:
	default:
		return BillingReconciliationResult{}, ErrBillingReconciliation
	}
	providerResult := service.executor.ReconcileSubscription(ctx, plan.Command)
	if providerResult.Kind != stripebilling.WebhookAccepted {
		return BillingReconciliationResult{}, ErrBillingReconciliation
	}
	switch providerResult.Outcome {
	case billing.ResultApplied:
		return billingReconciliationResult(BillingReconciliationApplied, command), nil
	case billing.ResultIgnored:
		return billingReconciliationResult(BillingReconciliationIgnored, command), nil
	case billing.ResultDuplicate, billing.ResultReplayed:
		return billingReconciliationResult(BillingReconciliationReplayed, command), nil
	default:
		return BillingReconciliationResult{}, ErrBillingReconciliation
	}
}

func PlanBillingReconciliation(
	command BillingReconciliationCommand,
	record *billing.SubscriptionRecord,
	checkpoint *billing.ReconciliationCheckpoint,
) BillingReconciliationPlan {
	if ValidateBillingReconciliationCommand(command) != nil {
		return refusedBillingReconciliationPlan(BillingReconciliationInvalidInput)
	}
	if record == nil {
		return refusedBillingReconciliationPlan(BillingReconciliationOwnerMismatch)
	}
	if !billing.ValidRecord(*record) || record.AccountID != command.AccountID || record.VaultID != command.VaultID {
		return refusedBillingReconciliationPlan(BillingReconciliationInvalidStoredState)
	}
	providerCommand := stripebilling.ReconciliationCommand{
		SnapshotID: command.SnapshotID, SubscriptionID: record.SubscriptionID,
		ProviderCustomerReference:     record.ProviderCustomerReference,
		ProviderSubscriptionReference: record.ProviderSubscriptionReference,
		ObservedAt:                    command.ObservedAt, RecordedAt: command.RecordedAt,
	}
	if record.Provider != stripebilling.Provider || record.ProviderCustomerReference == "" ||
		record.ProviderSubscriptionReference == "" || stripebilling.ValidateReconciliationCommand(providerCommand) != nil {
		return refusedBillingReconciliationPlan(BillingReconciliationProviderNotLinked)
	}
	if checkpoint == nil {
		return BillingReconciliationPlan{Kind: BillingReconciliationPlanExecute, Command: providerCommand}
	}
	if !validBillingReconciliationCheckpoint(*checkpoint) || checkpoint.Provider != stripebilling.Provider ||
		checkpoint.SnapshotID != command.SnapshotID || checkpoint.SubscriptionID != record.SubscriptionID ||
		checkpoint.ObservedAt != command.ObservedAt || checkpoint.RecordedAt != command.RecordedAt {
		return refusedBillingReconciliationPlan(BillingReconciliationSnapshotConflict)
	}
	return BillingReconciliationPlan{Kind: BillingReconciliationPlanReplay, Command: providerCommand}
}

func ValidateBillingReconciliationCommand(command BillingReconciliationCommand) error {
	if _, err := identity.ParseAccountID(string(command.AccountID)); err != nil {
		return ErrBillingReconciliation
	}
	if _, err := identity.ParseVaultID(string(command.VaultID)); err != nil {
		return ErrBillingReconciliation
	}
	if _, err := billing.ParseReconciliationSnapshotID(string(command.SnapshotID)); err != nil {
		return ErrBillingReconciliation
	}
	if command.ObservedAt <= 0 || !validTimestamp(command.ObservedAt) ||
		!validTimestamp(command.RecordedAt) || command.RecordedAt < command.ObservedAt {
		return ErrBillingReconciliation
	}
	return nil
}

func validBillingReconciliationCheckpoint(checkpoint billing.ReconciliationCheckpoint) bool {
	_, providerErr := billing.ParseProvider(string(checkpoint.Provider))
	_, snapshotErr := billing.ParseReconciliationSnapshotID(string(checkpoint.SnapshotID))
	_, subscriptionErr := billing.ParseSubscriptionID(string(checkpoint.SubscriptionID))
	_, versionErr := billing.ParseVersion(int64(checkpoint.AppliedVersion))
	return providerErr == nil && snapshotErr == nil && subscriptionErr == nil && versionErr == nil &&
		validTimestamp(checkpoint.ObservedAt) && validTimestamp(checkpoint.RecordedAt) &&
		checkpoint.RecordedAt >= checkpoint.ObservedAt
}

func refusedBillingReconciliationPlan(reason BillingReconciliationRefusal) BillingReconciliationPlan {
	return BillingReconciliationPlan{Kind: BillingReconciliationPlanRefuse, Reason: reason}
}

func refusedBillingReconciliation(
	command BillingReconciliationCommand,
	reason BillingReconciliationRefusal,
) BillingReconciliationResult {
	result := billingReconciliationResult(BillingReconciliationRefused, command)
	result.Reason = reason
	return result
}

func billingReconciliationResult(
	kind BillingReconciliationResultKind,
	command BillingReconciliationCommand,
) BillingReconciliationResult {
	return BillingReconciliationResult{
		Kind: kind, SnapshotID: command.SnapshotID,
		ObservedAt: command.ObservedAt, RecordedAt: command.RecordedAt,
	}
}
