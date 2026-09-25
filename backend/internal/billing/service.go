package billing

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrInvalidServiceConfiguration = errors.New("invalid billing service configuration")

type CommandResultKind string

const (
	ResultApplied   CommandResultKind = "applied"
	ResultReplayed  CommandResultKind = "replayed"
	ResultDuplicate CommandResultKind = "duplicate"
	ResultIgnored   CommandResultKind = "ignored"
	ResultRejected  CommandResultKind = "rejected"
)

type ResultReason string

const (
	ResultOwnerMismatch      ResultReason = "owner-mismatch"
	ResultIdentifierConflict ResultReason = "identifier-conflict"
	ResultNotFound           ResultReason = "not-found"
	ResultInvalidTransition  ResultReason = "invalid-transition"
	ResultMappingMismatch    ResultReason = "mapping-mismatch"
	ResultProviderMismatch   ResultReason = "provider-mismatch"
	ResultCASConflict        ResultReason = "cas-conflict"
	ResultStale              ResultReason = "stale"
	ResultTerminal           ResultReason = "terminal"
	ResultNoChange           ResultReason = "no-change"
)

type SubscriptionFacts struct {
	SubscriptionID     SubscriptionID
	AccountID          identity.AccountID
	VaultID            identity.VaultID
	Version            Version
	Lifecycle          Lifecycle
	PaymentMethodReady bool
	CancelAt           *int64
	UpdatedAt          int64
}

type CommandResult struct {
	Kind   CommandResultKind
	Reason ResultReason
	Facts  *SubscriptionFacts
}

type RecordCheckoutOpenedCommand struct {
	SubscriptionID            SubscriptionID
	CheckoutIntentID          CheckoutIntentID
	ProviderCheckoutReference ProviderCheckoutReference
	OpenedAt                  int64
}

type Service struct {
	ownership  OwnershipPort
	repository BillingRepository
}

func NewService(ownership OwnershipPort, repository BillingRepository) (*Service, error) {
	if ownership == nil || repository == nil {
		return nil, ErrInvalidServiceConfiguration
	}
	return &Service{ownership: ownership, repository: repository}, nil
}

func (service *Service) BeginCheckout(
	ctx context.Context,
	context identity.VaultContext,
	command BeginCheckoutCommand,
) (CommandResult, error) {
	owned, err := service.ownership.Owns(ctx, context)
	if err != nil {
		return CommandResult{}, err
	}
	if !owned {
		return rejectedResult(ResultOwnerMismatch), nil
	}
	plan := PlanCheckoutCreation(OwnerScope{AccountID: context.AccountID, VaultID: context.VaultID}, command)
	if plan.Kind == CheckoutPlanRejected {
		return rejectedResult(ResultInvalidTransition), nil
	}
	intent := CheckoutIntentRecord{
		CheckoutIntentID: command.CheckoutID,
		SubscriptionID:   command.SubscriptionID,
		Provider:         command.Provider,
		Status:           CheckoutIntentCreated,
		CreatedAt:        command.CreatedAt,
	}
	created, err := service.repository.CreateCheckout(ctx, plan.Record, intent)
	if err != nil {
		return CommandResult{}, err
	}
	if created.Kind == CheckoutCreated {
		return resultWithFacts(ResultApplied, "", plan.Record), nil
	}
	if created.Record != nil && created.Intent != nil && sameCheckout(*created.Record, *created.Intent, plan.Record, intent) {
		return resultWithFacts(ResultReplayed, "", *created.Record), nil
	}
	return rejectedResult(ResultIdentifierConflict), nil
}

func (service *Service) RecordCheckoutOpened(
	ctx context.Context,
	context identity.VaultContext,
	command RecordCheckoutOpenedCommand,
) (CommandResult, error) {
	owned, err := service.ownership.Owns(ctx, context)
	if err != nil {
		return CommandResult{}, err
	}
	if !owned {
		return rejectedResult(ResultOwnerMismatch), nil
	}
	current, err := service.repository.FindByOwner(ctx, OwnerScope{AccountID: context.AccountID, VaultID: context.VaultID})
	if err != nil {
		return CommandResult{}, err
	}
	intent, err := service.repository.FindCheckoutIntent(ctx, command.CheckoutIntentID)
	if err != nil {
		return CommandResult{}, err
	}
	if current == nil || intent == nil || current.SubscriptionID != command.SubscriptionID || intent.SubscriptionID != command.SubscriptionID {
		return rejectedResult(ResultNotFound), nil
	}
	if _, err := ParseProviderCheckoutReference(string(command.ProviderCheckoutReference)); err != nil ||
		!validTimestamp(command.OpenedAt) || command.OpenedAt < intent.CreatedAt {
		return rejectedResult(ResultInvalidTransition), nil
	}
	mapped, err := service.repository.FindCheckoutByProviderReference(ctx, intent.Provider, command.ProviderCheckoutReference)
	if err != nil {
		return CommandResult{}, err
	}
	if mapped != nil && mapped.CheckoutIntentID != command.CheckoutIntentID {
		return rejectedResult(ResultIdentifierConflict), nil
	}
	opened := *intent
	opened.ProviderCheckoutReference = command.ProviderCheckoutReference
	opened.Status = CheckoutIntentOpened
	opened.OpenedAt = pointer(command.OpenedAt)
	committed, err := service.repository.OpenCheckout(
		ctx,
		OwnerScope{AccountID: context.AccountID, VaultID: context.VaultID},
		opened,
	)
	if err != nil {
		return CommandResult{}, err
	}
	if committed == CommitConflict {
		return rejectedResult(ResultIdentifierConflict), nil
	}
	if committed == CommitApplied {
		return resultWithFacts(ResultApplied, "", *current), nil
	}
	return resultWithFacts(ResultReplayed, "", *current), nil
}

func (service *Service) IngestVerifiedProviderFact(
	ctx context.Context,
	fact VerifiedProviderFact,
) (CommandResult, error) {
	current, err := service.repository.FindByID(ctx, fact.SubscriptionID)
	if err != nil {
		return CommandResult{}, err
	}
	if current == nil {
		return rejectedResult(ResultNotFound), nil
	}
	mapped, err := service.repository.FindByProviderMapping(
		ctx, fact.Provider, fact.ProviderCustomerReference, fact.ProviderSubscriptionReference,
	)
	if err != nil {
		return CommandResult{}, err
	}
	if mapped != nil && mapped.SubscriptionID != fact.SubscriptionID {
		return rejectedResult(ResultMappingMismatch), nil
	}
	existing, err := service.repository.FindProviderEventReceipt(ctx, fact.Provider, fact.EventID)
	if err != nil {
		return CommandResult{}, err
	}
	if existing != nil {
		if existing.SubscriptionID != current.SubscriptionID {
			return rejectedResult(ResultMappingMismatch), nil
		}
		return resultWithFacts(ResultDuplicate, "", *current), nil
	}
	plan := PlanVerifiedProviderFact(*current, fact)
	if plan.Kind == ProviderFactRejected {
		return rejectedResult(mapPlanReason(plan.Reason)), nil
	}
	receipt := ProviderEventReceipt{
		Provider: fact.Provider, EventID: fact.EventID, SubscriptionID: fact.SubscriptionID,
		FactKind: fact.Kind, OccurredAt: fact.OccurredAt, AppliedVersion: plan.Record.Version, RecordedAt: fact.RecordedAt,
	}
	if plan.Kind == ProviderFactIgnore {
		receipt.Outcome = ReceiptIgnored
		stored, storeErr := service.repository.RecordIgnoredProviderFact(ctx, receipt)
		if storeErr != nil {
			return CommandResult{}, storeErr
		}
		if stored == CommitDuplicate {
			return resultWithFacts(ResultDuplicate, "", *current), nil
		}
		if stored == CommitConflict {
			return rejectedResult(ResultMappingMismatch), nil
		}
		return resultWithFacts(ResultIgnored, mapPlanReason(plan.Reason), plan.Record), nil
	}
	receipt.Outcome = ReceiptApplied
	committed, err := service.repository.CommitProviderFact(ctx, *current, plan.Record, receipt)
	if err != nil {
		return CommandResult{}, err
	}
	return service.commitResult(ctx, committed, plan.Record, fact.SubscriptionID)
}

func (service *Service) ReconcileVerifiedSnapshot(
	ctx context.Context,
	snapshot ReconciliationSnapshot,
) (CommandResult, error) {
	current, err := service.repository.FindByID(ctx, snapshot.SubscriptionID)
	if err != nil {
		return CommandResult{}, err
	}
	if current == nil {
		return rejectedResult(ResultNotFound), nil
	}
	mapped, err := service.repository.FindByProviderMapping(
		ctx, snapshot.Provider, snapshot.ProviderCustomerReference, snapshot.ProviderSubscriptionReference,
	)
	if err != nil {
		return CommandResult{}, err
	}
	if mapped != nil && mapped.SubscriptionID != snapshot.SubscriptionID {
		return rejectedResult(ResultMappingMismatch), nil
	}
	existing, err := service.repository.FindReconciliationCheckpoint(ctx, snapshot.Provider, snapshot.SnapshotID)
	if err != nil {
		return CommandResult{}, err
	}
	if existing != nil {
		if existing.SubscriptionID != current.SubscriptionID {
			return rejectedResult(ResultMappingMismatch), nil
		}
		return resultWithFacts(ResultDuplicate, "", *current), nil
	}
	plan := PlanReconciliationSnapshot(*current, snapshot)
	if plan.Kind == ProviderFactRejected {
		return rejectedResult(mapPlanReason(plan.Reason)), nil
	}
	checkpoint := ReconciliationCheckpoint{
		Provider: snapshot.Provider, SnapshotID: snapshot.SnapshotID, SubscriptionID: snapshot.SubscriptionID,
		ObservedAt: snapshot.ObservedAt, AppliedVersion: plan.Record.Version, RecordedAt: snapshot.RecordedAt,
	}
	if plan.Kind == ProviderFactIgnore {
		stored, storeErr := service.repository.RecordIgnoredReconciliation(ctx, checkpoint)
		if storeErr != nil {
			return CommandResult{}, storeErr
		}
		if stored == CommitDuplicate {
			return resultWithFacts(ResultDuplicate, "", *current), nil
		}
		if stored == CommitConflict {
			return rejectedResult(ResultMappingMismatch), nil
		}
		return resultWithFacts(ResultIgnored, mapPlanReason(plan.Reason), plan.Record), nil
	}
	committed, err := service.repository.CommitReconciliation(ctx, *current, plan.Record, checkpoint)
	if err != nil {
		return CommandResult{}, err
	}
	return service.commitResult(ctx, committed, plan.Record, snapshot.SubscriptionID)
}

func (service *Service) ReadSubscription(
	ctx context.Context,
	context identity.VaultContext,
) (*SubscriptionFacts, error) {
	owned, err := service.ownership.Owns(ctx, context)
	if err != nil || !owned {
		return nil, err
	}
	record, err := service.repository.FindByOwner(ctx, OwnerScope{AccountID: context.AccountID, VaultID: context.VaultID})
	if err != nil || record == nil {
		return nil, err
	}
	facts := factsFrom(*record)
	return &facts, nil
}

func (service *Service) commitResult(
	ctx context.Context,
	kind CommitKind,
	planned SubscriptionRecord,
	subscriptionID SubscriptionID,
) (CommandResult, error) {
	switch kind {
	case CommitApplied:
		return resultWithFacts(ResultApplied, "", planned), nil
	case CommitDuplicate:
		current, err := service.repository.FindByID(ctx, subscriptionID)
		if err != nil {
			return CommandResult{}, err
		}
		if current == nil {
			return rejectedResult(ResultNotFound), nil
		}
		return resultWithFacts(ResultDuplicate, "", *current), nil
	default:
		return rejectedResult(ResultCASConflict), nil
	}
}

func sameCheckout(
	existingRecord SubscriptionRecord,
	existingIntent CheckoutIntentRecord,
	proposedRecord SubscriptionRecord,
	proposedIntent CheckoutIntentRecord,
) bool {
	return existingRecord.SubscriptionID == proposedRecord.SubscriptionID &&
		existingRecord.AccountID == proposedRecord.AccountID && existingRecord.VaultID == proposedRecord.VaultID &&
		existingRecord.Provider == proposedRecord.Provider &&
		existingIntent.CheckoutIntentID == proposedIntent.CheckoutIntentID &&
		existingIntent.SubscriptionID == proposedIntent.SubscriptionID && existingIntent.Provider == proposedIntent.Provider &&
		existingIntent.CreatedAt == proposedIntent.CreatedAt
}

func factsFrom(record SubscriptionRecord) SubscriptionFacts {
	return SubscriptionFacts{
		SubscriptionID: record.SubscriptionID, AccountID: record.AccountID, VaultID: record.VaultID,
		Version: record.Version, Lifecycle: record.Lifecycle, PaymentMethodReady: record.PaymentMethodReady,
		CancelAt: cloneTimestamp(record.CancelAt), UpdatedAt: record.UpdatedAt,
	}
}

func resultWithFacts(kind CommandResultKind, reason ResultReason, record SubscriptionRecord) CommandResult {
	facts := factsFrom(record)
	return CommandResult{Kind: kind, Reason: reason, Facts: &facts}
}

func rejectedResult(reason ResultReason) CommandResult {
	return CommandResult{Kind: ResultRejected, Reason: reason}
}

func mapPlanReason(reason PlanReason) ResultReason {
	switch reason {
	case ReasonProviderMismatch:
		return ResultProviderMismatch
	case ReasonMappingMismatch:
		return ResultMappingMismatch
	case ReasonStale:
		return ResultStale
	case ReasonTerminal:
		return ResultTerminal
	case ReasonNoChange:
		return ResultNoChange
	default:
		return ResultInvalidTransition
	}
}
