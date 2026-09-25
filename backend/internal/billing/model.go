package billing

import "github.com/fukamu/notes/backend/internal/identity"

const (
	TrialDurationMilliseconds int64 = 14 * 24 * 60 * 60 * 1_000
	maximumSafeInteger        int64 = 9_007_199_254_740_991
)

type LifecycleKind string

const (
	LifecycleCheckoutPending LifecycleKind = "checkout-pending"
	LifecycleTrialing        LifecycleKind = "trialing"
	LifecycleActive          LifecycleKind = "active"
	LifecycleDelinquent      LifecycleKind = "delinquent"
	LifecycleCancelled       LifecycleKind = "cancelled"
)

type DelinquencyReason string

const (
	DelinquencyPaymentFailed         DelinquencyReason = "payment-failed"
	DelinquencyPaymentActionRequired DelinquencyReason = "payment-action-required"
)

type Lifecycle struct {
	Kind                LifecycleKind
	TrialStartedAt      int64
	TrialEndsAt         int64
	PaidPeriodStartedAt int64
	PaidThrough         int64
	DelinquencyReason   DelinquencyReason
	DelinquencySince    int64
	InvoiceReference    ProviderInvoiceReference
	CancelledAt         int64
}

type SubscriptionRecord struct {
	SubscriptionID                SubscriptionID
	AccountID                     identity.AccountID
	VaultID                       identity.VaultID
	Provider                      Provider
	ProviderCustomerReference     ProviderCustomerReference
	ProviderSubscriptionReference ProviderSubscriptionReference
	Version                       Version
	Lifecycle                     Lifecycle
	PaymentMethodReady            bool
	PaymentMethodUpdatedAt        *int64
	TrialObservedAt               *int64
	LastPaidAt                    *int64
	LastPaidInvoiceReference      ProviderInvoiceReference
	LastDelinquencyAt             *int64
	CancellationUpdatedAt         *int64
	CancelAt                      *int64
	LastReconciledAt              *int64
	CreatedAt                     int64
	UpdatedAt                     int64
}

type OwnerScope struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
}

func (scope OwnerScope) Valid() bool {
	_, accountErr := identity.ParseAccountID(string(scope.AccountID))
	_, vaultErr := identity.ParseVaultID(string(scope.VaultID))
	return accountErr == nil && vaultErr == nil
}

type BeginCheckoutCommand struct {
	SubscriptionID SubscriptionID
	CheckoutID     CheckoutIntentID
	Provider       Provider
	CreatedAt      int64
}

type FactKind string

const (
	FactTrialStarted                 FactKind = "trial-started"
	FactPaymentMethodUpdated         FactKind = "payment-method-updated"
	FactInvoicePaid                  FactKind = "invoice-paid"
	FactInvoicePaymentFailed         FactKind = "invoice-payment-failed"
	FactInvoicePaymentActionRequired FactKind = "invoice-payment-action-required"
	FactCancellationScheduled        FactKind = "cancellation-scheduled"
	FactSubscriptionCancelled        FactKind = "subscription-cancelled"
)

type VerifiedProviderFact struct {
	Kind                          FactKind
	SubscriptionID                SubscriptionID
	Provider                      Provider
	EventID                       ProviderEventID
	ProviderCustomerReference     ProviderCustomerReference
	ProviderSubscriptionReference ProviderSubscriptionReference
	OccurredAt                    int64
	RecordedAt                    int64
	TrialStartedAt                int64
	TrialEndsAt                   int64
	InvoiceReference              ProviderInvoiceReference
	PaidPeriodStartedAt           int64
	PaidPeriodEndsAt              int64
	CancelAt                      int64
	CancelledAt                   int64
}

type ReconciliationTrial struct {
	StartedAt  int64
	EndsAt     int64
	ObservedAt int64
}

type ReconciliationPaidInvoice struct {
	InvoiceReference ProviderInvoiceReference
	PaidAt           int64
	PeriodStartedAt  int64
	PeriodEndsAt     int64
}

type ReconciliationDelinquency struct {
	Reason           DelinquencyReason
	InvoiceReference ProviderInvoiceReference
	OccurredAt       int64
}

type ReconciliationSnapshot struct {
	SnapshotID                    ReconciliationSnapshotID
	SubscriptionID                SubscriptionID
	Provider                      Provider
	ProviderCustomerReference     ProviderCustomerReference
	ProviderSubscriptionReference ProviderSubscriptionReference
	ObservedAt                    int64
	RecordedAt                    int64
	PaymentMethodReady            bool
	PaymentMethodUpdatedAt        int64
	Trial                         *ReconciliationTrial
	LatestPaidInvoice             *ReconciliationPaidInvoice
	Delinquency                   *ReconciliationDelinquency
	CancelAt                      *int64
	CancellationUpdatedAt         int64
	CancelledAt                   *int64
}

type CheckoutIntentStatus string

const (
	CheckoutIntentCreated CheckoutIntentStatus = "created"
	CheckoutIntentOpened  CheckoutIntentStatus = "opened"
)

type CheckoutIntentRecord struct {
	CheckoutIntentID          CheckoutIntentID
	SubscriptionID            SubscriptionID
	Provider                  Provider
	ProviderCheckoutReference ProviderCheckoutReference
	Status                    CheckoutIntentStatus
	CreatedAt                 int64
	OpenedAt                  *int64
}

type ReceiptOutcome string

const (
	ReceiptApplied ReceiptOutcome = "applied"
	ReceiptIgnored ReceiptOutcome = "ignored"
)

type ProviderEventReceipt struct {
	Provider       Provider
	EventID        ProviderEventID
	SubscriptionID SubscriptionID
	FactKind       FactKind
	Outcome        ReceiptOutcome
	OccurredAt     int64
	AppliedVersion Version
	RecordedAt     int64
}

type ReconciliationCheckpoint struct {
	Provider       Provider
	SnapshotID     ReconciliationSnapshotID
	SubscriptionID SubscriptionID
	ObservedAt     int64
	AppliedVersion Version
	RecordedAt     int64
}

func validTimestamp(value int64) bool {
	return value >= 0 && value <= maximumSafeInteger
}

func pointer(value int64) *int64 {
	copy := value
	return &copy
}

func cloneTimestamp(value *int64) *int64 {
	if value == nil {
		return nil
	}
	return pointer(*value)
}
