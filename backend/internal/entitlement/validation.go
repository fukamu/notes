package entitlement

import (
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
)

func ValidVaultContext(value identity.VaultContext) bool {
	_, accountErr := identity.ParseAccountID(string(value.AccountID))
	_, vaultErr := identity.ParseVaultID(string(value.VaultID))
	_, sessionErr := identity.ParseSessionID(string(value.SessionID))
	_, epochErr := identity.ParseSessionEpoch(int64(value.SessionEpoch))
	return accountErr == nil && vaultErr == nil && sessionErr == nil && epochErr == nil
}

func ValidProjectionRecord(value ProjectionRecord) bool {
	if _, err := identity.ParseAccountID(string(value.AccountID)); err != nil {
		return false
	}
	if _, err := identity.ParseVaultID(string(value.VaultID)); err != nil {
		return false
	}
	if _, err := ParseProjectionVersion(int64(value.Version)); err != nil {
		return false
	}
	if _, err := billing.ParseSubscriptionID(string(value.SourceSubscriptionID)); err != nil {
		return false
	}
	if _, err := billing.ParseVersion(int64(value.SourceBillingVersion)); err != nil {
		return false
	}
	if !validTimestamp(value.CheckedAt) || !validTimestamp(value.CreatedAt) ||
		value.UpdatedAt != value.CheckedAt || value.CreatedAt > value.UpdatedAt {
		return false
	}
	return validState(value.State, value.CheckedAt)
}

func ValidOfflineLeaseRecord(value OfflineLeaseRecord) bool {
	if !validPublicOfflineLease(value.OfflineLease) {
		return false
	}
	if _, err := billing.ParseSubscriptionID(string(value.SourceSubscriptionID)); err != nil {
		return false
	}
	if _, err := billing.ParseVersion(int64(value.SourceBillingVersion)); err != nil {
		return false
	}
	return true
}

func validPublicOfflineLease(value OfflineLease) bool {
	if _, err := ParseOfflineLeaseID(string(value.LeaseID)); err != nil || !ValidVaultContext(value.Context) {
		return false
	}
	if value.Basis != BasisTrial && value.Basis != BasisPaid {
		return false
	}
	if !validTimestamp(value.IssuedAt) || !validTimestamp(value.ExpiresAt) || value.ExpiresAt <= value.IssuedAt {
		return false
	}
	return value.RevokedAt == nil || validTimestamp(*value.RevokedAt) && *value.RevokedAt >= value.IssuedAt
}

func validPolicy(value OfflineLeasePolicy) bool {
	switch value.Kind {
	case OfflineLeaseUndecided:
		return value.Duration == 0
	case OfflineLeaseConfigured:
		return value.Duration > 0 && value.Duration <= MaximumSafeInteger
	default:
		return false
	}
}

func validState(value State, checkedAt int64) bool {
	return validStateShape(value) && (value.Kind == StateLocked || value.ValidUntil > checkedAt)
}

func validStateShape(value State) bool {
	switch value.Kind {
	case StateTrialActive, StatePaidActive:
		return validTimestamp(value.ValidUntil) && value.Reason == ""
	case StateLocked:
		return value.ValidUntil == 0 && validLockReason(value.Reason)
	default:
		return false
	}
}

func validLockReason(value LockReason) bool {
	switch value {
	case LockCheckoutIncomplete, LockPaymentMethodRequired, LockTrialExpired,
		LockPaidPeriodExpired, LockPaymentFailed, LockPaymentActionRequired, LockCancelled:
		return true
	default:
		return false
	}
}

func validCapability(value Capability) bool {
	switch value {
	case CapabilityNotesRead, CapabilityNotesWrite, CapabilityNotesSync,
		CapabilityBillingRecovery, CapabilitySubscriptionCancel, CapabilityAccountDelete, CapabilitySupport:
		return true
	default:
		return false
	}
}

func validTimestamp(value int64) bool {
	return value >= 0 && value <= MaximumSafeInteger
}
