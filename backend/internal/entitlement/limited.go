package entitlement

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
)

type LimitedAccessGrant struct {
	AccountID   identity.AccountID
	VaultID     identity.VaultID
	GrantedAt   int64
	ExpiresAt   int64
	RevokedAt   *int64
	VaultLimits PersonalVaultLimits
}

func ValidLimitedAccessGrant(grant LimitedAccessGrant) bool {
	return validLimitedScope(grant.AccountID, grant.VaultID) &&
		validTimestamp(grant.GrantedAt) && validTimestamp(grant.ExpiresAt) &&
		grant.ExpiresAt > grant.GrantedAt &&
		(grant.RevokedAt == nil || validTimestamp(*grant.RevokedAt) && *grant.RevokedAt >= grant.GrantedAt) &&
		validPersonalVaultLimits(grant.VaultLimits)
}

func ValidPersonalVaultLimits(limits PersonalVaultLimits) bool {
	return validPersonalVaultLimits(limits)
}

func AuthorizeLimitedAccess(
	grant *LimitedAccessGrant,
	vaultContext identity.VaultContext,
	capability Capability,
	checkedAt int64,
) Decision {
	if !ValidVaultContext(vaultContext) || !validCapability(capability) ||
		!validTimestamp(checkedAt) || !isContentCapability(capability) {
		return denied(capability, DenialInvalidInput)
	}
	if grant == nil {
		return denied(capability, DenialLimitedAccessRequired)
	}
	if !ValidLimitedAccessGrant(*grant) {
		return denied(capability, DenialEntitlementUnavailable)
	}
	if grant.AccountID != vaultContext.AccountID || grant.VaultID != vaultContext.VaultID {
		return denied(capability, DenialOwnerMismatch)
	}
	if grant.RevokedAt != nil && checkedAt >= *grant.RevokedAt {
		return denied(capability, DenialLimitedAccessRevoked)
	}
	if checkedAt >= grant.ExpiresAt {
		return denied(capability, DenialLimitedAccessExpired)
	}
	validUntil := grant.ExpiresAt
	if grant.RevokedAt != nil && *grant.RevokedAt < validUntil {
		validUntil = *grant.RevokedAt
	}
	return Decision{
		Kind: DecisionAllowed, Capability: capability, Basis: BasisLimited,
		ValidUntil: pointer(validUntil),
	}
}

type LimitedAccessReader interface {
	FindLimitedAccessGrant(
		context.Context,
		identity.AccountID,
		identity.VaultID,
	) (*LimitedAccessGrant, error)
}

type LimitedAccessService struct {
	reader LimitedAccessReader
}

func NewLimitedAccessService(reader LimitedAccessReader) (*LimitedAccessService, error) {
	if reader == nil {
		return nil, errors.New("limited access reader is required")
	}
	return &LimitedAccessService{reader: reader}, nil
}

func (service *LimitedAccessService) AuthorizeCapability(
	ctx context.Context,
	vaultContext identity.VaultContext,
	capability Capability,
	checkedAt int64,
) Decision {
	grant, err := service.read(ctx, vaultContext)
	if err != nil {
		return denied(capability, DenialEntitlementUnavailable)
	}
	return AuthorizeLimitedAccess(grant, vaultContext, capability, checkedAt)
}

func (service *LimitedAccessService) ReadLimits(
	ctx context.Context,
	vaultContext identity.VaultContext,
	checkedAt int64,
) LimitDecision {
	grant, err := service.read(ctx, vaultContext)
	if err != nil {
		return LimitDecision{Kind: LimitsDenied, Reason: DenialEntitlementUnavailable}
	}
	decision := AuthorizeLimitedAccess(grant, vaultContext, CapabilityNotesSync, checkedAt)
	if decision.Kind != DecisionAllowed || grant == nil || decision.ValidUntil == nil {
		return LimitDecision{Kind: LimitsDenied, Reason: decision.Reason}
	}
	return LimitDecision{
		Kind: LimitsAvailable, Limits: grant.VaultLimits, ValidUntil: *decision.ValidUntil,
	}
}

func (service *LimitedAccessService) read(
	ctx context.Context,
	vaultContext identity.VaultContext,
) (*LimitedAccessGrant, error) {
	if service == nil || service.reader == nil || !ValidVaultContext(vaultContext) {
		return nil, errors.New("limited access service is unavailable")
	}
	return service.reader.FindLimitedAccessGrant(
		ctx, vaultContext.AccountID, vaultContext.VaultID,
	)
}

func validLimitedScope(accountID identity.AccountID, vaultID identity.VaultID) bool {
	_, accountErr := identity.ParseAccountID(string(accountID))
	_, vaultErr := identity.ParseVaultID(string(vaultID))
	return accountErr == nil && vaultErr == nil
}

func validPersonalVaultLimits(limits PersonalVaultLimits) bool {
	return limits.ActiveCards > 0 && limits.ActiveCards <= MaximumSafeInteger &&
		limits.DisplayCharactersPerCard > 0 && limits.DisplayCharactersPerCard <= MaximumSafeInteger &&
		limits.SerializedPlaintextBytesPerCard > 0 && limits.SerializedPlaintextBytesPerCard <= MaximumSafeInteger &&
		limits.PlaintextBytesPerVault > 0 && limits.PlaintextBytesPerVault <= MaximumSafeInteger
}
