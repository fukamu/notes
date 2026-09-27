package entitlement

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrInvalidServiceConfiguration = errors.New("invalid entitlement service configuration")

type Service struct {
	billing    BillingPort
	ownership  OwnershipPort
	repository Repository
	policy     OfflineLeasePolicy
}

func NewService(
	billingPort BillingPort,
	ownership OwnershipPort,
	repository Repository,
	policy OfflineLeasePolicy,
) (*Service, error) {
	if billingPort == nil || ownership == nil || repository == nil || !validPolicy(policy) {
		return nil, ErrInvalidServiceConfiguration
	}
	return &Service{billing: billingPort, ownership: ownership, repository: repository, policy: policy}, nil
}

func (service *Service) AuthorizeCapability(
	ctx context.Context,
	vaultContext identity.VaultContext,
	capability Capability,
	checkedAt int64,
) Decision {
	if service == nil || !validCapability(capability) || !ValidVaultContext(vaultContext) || !validTimestamp(checkedAt) {
		return denied(capability, DenialInvalidInput)
	}
	owner := service.verifyOwner(ctx, vaultContext)
	if owner != "" {
		return denied(capability, owner)
	}
	projection, reason := service.refreshProjection(ctx, vaultContext, checkedAt)
	if reason != "" {
		if isRecoveryCapability(capability) && reason != DenialInvalidInput {
			return Decision{Kind: DecisionAllowed, Capability: capability, Basis: BasisRecovery}
		}
		return denied(capability, reason)
	}
	return AuthorizeState(projection.State, capability, checkedAt)
}

func (service *Service) ReadLimits(
	ctx context.Context,
	vaultContext identity.VaultContext,
	checkedAt int64,
) LimitDecision {
	if service == nil || !ValidVaultContext(vaultContext) || !validTimestamp(checkedAt) {
		return LimitDecision{Kind: LimitsDenied, Reason: DenialInvalidInput}
	}
	if reason := service.verifyOwner(ctx, vaultContext); reason != "" {
		return LimitDecision{Kind: LimitsDenied, Reason: reason}
	}
	projection, reason := service.refreshProjection(ctx, vaultContext, checkedAt)
	if reason != "" {
		return LimitDecision{Kind: LimitsDenied, Reason: reason}
	}
	decision := AuthorizeState(projection.State, CapabilityNotesRead, checkedAt)
	if decision.Kind != DecisionAllowed || decision.ValidUntil == nil {
		if decision.Reason == "" {
			return LimitDecision{Kind: LimitsDenied, Reason: DenialEntitlementUnavailable}
		}
		return LimitDecision{Kind: LimitsDenied, Reason: decision.Reason}
	}
	return LimitDecision{Kind: LimitsAvailable, Limits: PaidPersonalVaultLimits(), ValidUntil: *decision.ValidUntil}
}

func (service *Service) IssueOfflineLease(
	ctx context.Context,
	vaultContext identity.VaultContext,
	leaseID OfflineLeaseID,
	issuedAt int64,
) LeaseCommandResult {
	if service == nil || !ValidVaultContext(vaultContext) || !validTimestamp(issuedAt) {
		return LeaseCommandResult{Kind: LeaseDenied, Reason: DenialInvalidInput}
	}
	if _, err := ParseOfflineLeaseID(string(leaseID)); err != nil {
		return LeaseCommandResult{Kind: LeaseDenied, Reason: DenialInvalidInput}
	}
	if reason := service.verifyOwner(ctx, vaultContext); reason != "" {
		return LeaseCommandResult{Kind: LeaseDenied, Reason: reason}
	}
	if service.policy.Kind == OfflineLeaseUndecided {
		return LeaseCommandResult{Kind: LeaseDenied, Reason: DenialLeasePolicyUndecided}
	}
	projection, reason := service.refreshProjection(ctx, vaultContext, issuedAt)
	if reason != "" {
		return LeaseCommandResult{Kind: LeaseDenied, Reason: reason}
	}
	plan := PlanOfflineLease(vaultContext, projection, service.policy, leaseID, issuedAt)
	if plan.Kind == OfflineLeaseDeny {
		return LeaseCommandResult{Kind: LeaseDenied, Reason: plan.Reason}
	}
	created, err := service.repository.CreateOfflineLease(ctx, projection.Version, plan.Lease)
	if err != nil {
		return LeaseCommandResult{Kind: LeaseDenied, Reason: DenialEntitlementUnavailable}
	}
	switch created.Kind {
	case LeaseCreateIssued:
		lease := publicLease(plan.Lease)
		return LeaseCommandResult{Kind: LeaseIssued, Lease: &lease}
	case LeaseCreateReplayed:
		if created.Lease == nil || !ValidOfflineLeaseRecord(*created.Lease) {
			return LeaseCommandResult{Kind: LeaseDenied, Reason: DenialEntitlementUnavailable}
		}
		lease := publicLease(*created.Lease)
		return LeaseCommandResult{Kind: LeaseReplayed, Lease: &lease}
	case LeaseCreateIdentifierConflict:
		return LeaseCommandResult{Kind: LeaseDenied, Reason: DenialIdentifierConflict}
	case LeaseCreateProjectionConflict:
		return LeaseCommandResult{Kind: LeaseDenied, Reason: DenialProjectionConflict}
	default:
		return LeaseCommandResult{Kind: LeaseDenied, Reason: DenialEntitlementUnavailable}
	}
}

func (service *Service) AuthorizeOfflineCapability(
	ctx context.Context,
	vaultContext identity.VaultContext,
	capability Capability,
	leaseID OfflineLeaseID,
	checkedAt int64,
) Decision {
	if service == nil || !validCapability(capability) || !ValidVaultContext(vaultContext) || !validTimestamp(checkedAt) {
		return denied(capability, DenialInvalidInput)
	}
	if _, err := ParseOfflineLeaseID(string(leaseID)); err != nil {
		return denied(capability, DenialInvalidInput)
	}
	if reason := service.verifyOwner(ctx, vaultContext); reason != "" {
		return denied(capability, reason)
	}
	lease, err := service.repository.FindOfflineLease(ctx, vaultContext, leaseID)
	if err != nil {
		return denied(capability, DenialEntitlementUnavailable)
	}
	if lease == nil {
		return denied(capability, DenialLeaseNotFound)
	}
	if !ValidOfflineLeaseRecord(*lease) {
		return denied(capability, DenialEntitlementUnavailable)
	}
	return AuthorizeOfflineLease(lease.OfflineLease, vaultContext, capability, checkedAt)
}

func (service *Service) refreshProjection(
	ctx context.Context,
	vaultContext identity.VaultContext,
	checkedAt int64,
) (ProjectionRecord, DenialReason) {
	facts, err := service.billing.ReadSubscription(ctx, vaultContext)
	if err != nil {
		return ProjectionRecord{}, DenialBillingUnavailable
	}
	if facts == nil {
		return ProjectionRecord{}, DenialSubscriptionRequired
	}
	evaluation := EvaluateSubscriptionFacts(*facts, checkedAt)
	if evaluation.Kind != EvaluationEvaluated {
		return ProjectionRecord{}, DenialBillingUnavailable
	}
	for attempt := 0; attempt < 2; attempt++ {
		current, findErr := service.repository.FindProjection(ctx, vaultContext)
		if findErr != nil {
			return ProjectionRecord{}, DenialEntitlementUnavailable
		}
		plan := PlanProjection(vaultContext, *facts, evaluation.State, checkedAt, current)
		switch plan.Kind {
		case ProjectionInvalid:
			return ProjectionRecord{}, DenialBillingUnavailable
		case ProjectionStale:
			return ProjectionRecord{}, DenialProjectionConflict
		case ProjectionCurrent:
			return plan.Record, ""
		case ProjectionCommit:
			var expected *ProjectionVersion
			if current != nil {
				value := current.Version
				expected = &value
			}
			var revokeAt *int64
			if plan.Record.State.Kind == StateLocked {
				revokeAt = pointer(checkedAt)
			}
			committed, commitErr := service.repository.CommitProjection(ctx, expected, plan.Record, revokeAt)
			if commitErr != nil {
				return ProjectionRecord{}, DenialEntitlementUnavailable
			}
			if committed == ProjectionApplied {
				return plan.Record, ""
			}
		default:
			return ProjectionRecord{}, DenialEntitlementUnavailable
		}
	}
	return ProjectionRecord{}, DenialProjectionConflict
}

func (service *Service) verifyOwner(ctx context.Context, vaultContext identity.VaultContext) DenialReason {
	owned, err := service.ownership.Owns(ctx, vaultContext)
	if err != nil {
		return DenialEntitlementUnavailable
	}
	if !owned {
		return DenialOwnerMismatch
	}
	return ""
}

func isRecoveryCapability(capability Capability) bool {
	return capability == CapabilityBillingRecovery || capability == CapabilitySubscriptionCancel ||
		capability == CapabilityAccountDelete || capability == CapabilitySupport
}

func publicLease(record OfflineLeaseRecord) OfflineLease {
	return OfflineLease{
		LeaseID: record.LeaseID, Context: record.Context, Basis: record.Basis,
		IssuedAt: record.IssuedAt, ExpiresAt: record.ExpiresAt, RevokedAt: cloneTimestamp(record.RevokedAt),
	}
}
