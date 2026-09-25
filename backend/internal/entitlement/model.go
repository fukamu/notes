package entitlement

import (
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	OfflineLeaseDurationMilliseconds int64 = 24 * 60 * 60 * 1_000
	MaximumSafeInteger               int64 = 9_007_199_254_740_991
)

type Capability string

const (
	CapabilityNotesRead          Capability = "notes-read"
	CapabilityNotesWrite         Capability = "notes-write"
	CapabilityNotesSync          Capability = "notes-sync"
	CapabilityBillingRecovery    Capability = "billing-recovery"
	CapabilitySubscriptionCancel Capability = "subscription-cancel"
	CapabilityAccountDelete      Capability = "account-delete"
	CapabilitySupport            Capability = "support"
)

type LockReason string

const (
	LockCheckoutIncomplete    LockReason = "checkout-incomplete"
	LockPaymentMethodRequired LockReason = "payment-method-required"
	LockTrialExpired          LockReason = "trial-expired"
	LockPaidPeriodExpired     LockReason = "paid-period-expired"
	LockPaymentFailed         LockReason = "payment-failed"
	LockPaymentActionRequired LockReason = "payment-action-required"
	LockCancelled             LockReason = "cancelled"
)

type StateKind string

const (
	StateTrialActive StateKind = "trial-active"
	StatePaidActive  StateKind = "paid-active"
	StateLocked      StateKind = "locked"
)

type State struct {
	Kind       StateKind
	ValidUntil int64
	Reason     LockReason
}

type DenialReason string

const (
	DenialOwnerMismatch          DenialReason = "owner-mismatch"
	DenialSubscriptionRequired   DenialReason = "subscription-required"
	DenialBillingUnavailable     DenialReason = "billing-unavailable"
	DenialEntitlementUnavailable DenialReason = "entitlement-unavailable"
	DenialInvalidInput           DenialReason = "invalid-input"
	DenialProjectionConflict     DenialReason = "projection-conflict"
	DenialLeasePolicyUndecided   DenialReason = "lease-policy-undecided"
	DenialLeaseNotFound          DenialReason = "lease-not-found"
	DenialLeaseExpired           DenialReason = "lease-expired"
	DenialLeaseRevoked           DenialReason = "lease-revoked"
	DenialLeaseScopeMismatch     DenialReason = "lease-scope-mismatch"
	DenialOnlineRequired         DenialReason = "online-required"
	DenialIdentifierConflict     DenialReason = "identifier-conflict"
)

type Basis string

const (
	BasisTrial    Basis = "trial"
	BasisPaid     Basis = "paid"
	BasisRecovery Basis = "recovery"
)

type DecisionKind string

const (
	DecisionAllowed DecisionKind = "allowed"
	DecisionDenied  DecisionKind = "denied"
)

type Decision struct {
	Kind       DecisionKind
	Capability Capability
	Basis      Basis
	ValidUntil *int64
	Reason     DenialReason
}

type PersonalVaultLimits struct {
	ActiveCards                     int64
	DisplayCharactersPerCard        int64
	SerializedPlaintextBytesPerCard int64
	PlaintextBytesPerVault          int64
}

func PaidPersonalVaultLimits() PersonalVaultLimits {
	return PersonalVaultLimits{
		ActiveCards: 10_000, DisplayCharactersPerCard: 1_000,
		SerializedPlaintextBytesPerCard: 8_192, PlaintextBytesPerVault: 134_217_728,
	}
}

type LimitDecisionKind string

const (
	LimitsAvailable LimitDecisionKind = "available"
	LimitsDenied    LimitDecisionKind = "denied"
)

type LimitDecision struct {
	Kind       LimitDecisionKind
	Limits     PersonalVaultLimits
	ValidUntil int64
	Reason     DenialReason
}

type OfflineLeasePolicyKind string

const (
	OfflineLeaseUndecided  OfflineLeasePolicyKind = "undecided"
	OfflineLeaseConfigured OfflineLeasePolicyKind = "configured"
)

type OfflineLeasePolicy struct {
	Kind     OfflineLeasePolicyKind
	Duration int64
}

func FukamuOfflineLeasePolicy() OfflineLeasePolicy {
	return OfflineLeasePolicy{
		Kind: OfflineLeaseConfigured, Duration: OfflineLeaseDurationMilliseconds,
	}
}

type OfflineLease struct {
	LeaseID   OfflineLeaseID
	Context   identity.VaultContext
	Basis     Basis
	IssuedAt  int64
	ExpiresAt int64
	RevokedAt *int64
}

type OfflineLeaseRecord struct {
	OfflineLease
	SourceSubscriptionID billing.SubscriptionID
	SourceBillingVersion billing.Version
}

type ProjectionRecord struct {
	AccountID            identity.AccountID
	VaultID              identity.VaultID
	Version              ProjectionVersion
	SourceSubscriptionID billing.SubscriptionID
	SourceBillingVersion billing.Version
	State                State
	CheckedAt            int64
	CreatedAt            int64
	UpdatedAt            int64
}

type LeaseCommandKind string

const (
	LeaseIssued   LeaseCommandKind = "issued"
	LeaseReplayed LeaseCommandKind = "replayed"
	LeaseDenied   LeaseCommandKind = "denied"
)

type LeaseCommandResult struct {
	Kind   LeaseCommandKind
	Lease  *OfflineLease
	Reason DenialReason
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
