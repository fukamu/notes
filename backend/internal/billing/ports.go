package billing

import (
	"context"

	"github.com/fukamu/notes/backend/internal/identity"
)

type OwnershipPort interface {
	Owns(context.Context, identity.VaultContext) (bool, error)
}

type CheckoutCreateKind string

const (
	CheckoutCreated  CheckoutCreateKind = "created"
	CheckoutExisting CheckoutCreateKind = "existing"
)

type CheckoutCreateResult struct {
	Kind   CheckoutCreateKind
	Record *SubscriptionRecord
	Intent *CheckoutIntentRecord
}

type CommitKind string

const (
	CommitApplied   CommitKind = "applied"
	CommitReplayed  CommitKind = "replayed"
	CommitDuplicate CommitKind = "duplicate"
	CommitConflict  CommitKind = "conflict"
)

type BillingRepository interface {
	FindByOwner(context.Context, OwnerScope) (*SubscriptionRecord, error)
	FindByID(context.Context, SubscriptionID) (*SubscriptionRecord, error)
	FindByProviderMapping(
		context.Context,
		Provider,
		ProviderCustomerReference,
		ProviderSubscriptionReference,
	) (*SubscriptionRecord, error)
	FindCheckoutIntent(context.Context, CheckoutIntentID) (*CheckoutIntentRecord, error)
	FindCheckoutByProviderReference(context.Context, Provider, ProviderCheckoutReference) (*CheckoutIntentRecord, error)
	CreateCheckout(context.Context, SubscriptionRecord, CheckoutIntentRecord) (CheckoutCreateResult, error)
	OpenCheckout(context.Context, OwnerScope, CheckoutIntentRecord) (CommitKind, error)
	FindProviderEventReceipt(context.Context, Provider, ProviderEventID) (*ProviderEventReceipt, error)
	CommitProviderFact(
		context.Context,
		SubscriptionRecord,
		SubscriptionRecord,
		ProviderEventReceipt,
	) (CommitKind, error)
	RecordIgnoredProviderFact(context.Context, ProviderEventReceipt) (CommitKind, error)
	FindReconciliationCheckpoint(
		context.Context,
		Provider,
		ReconciliationSnapshotID,
	) (*ReconciliationCheckpoint, error)
	CommitReconciliation(
		context.Context,
		SubscriptionRecord,
		SubscriptionRecord,
		ReconciliationCheckpoint,
	) (CommitKind, error)
	RecordIgnoredReconciliation(context.Context, ReconciliationCheckpoint) (CommitKind, error)
}
