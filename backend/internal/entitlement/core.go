package entitlement

import (
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
)

type EvaluationKind string

const (
	EvaluationEvaluated EvaluationKind = "evaluated"
	EvaluationInvalid   EvaluationKind = "invalid"
)

type SubscriptionEvaluation struct {
	Kind  EvaluationKind
	State State
}

type ProjectionPlanKind string

const (
	ProjectionCommit  ProjectionPlanKind = "commit"
	ProjectionCurrent ProjectionPlanKind = "current"
	ProjectionStale   ProjectionPlanKind = "stale"
	ProjectionInvalid ProjectionPlanKind = "invalid"
)

type ProjectionPlan struct {
	Kind   ProjectionPlanKind
	Record ProjectionRecord
}

type OfflineLeasePlanKind string

const (
	OfflineLeaseIssue OfflineLeasePlanKind = "issue"
	OfflineLeaseDeny  OfflineLeasePlanKind = "denied"
)

type OfflineLeasePlan struct {
	Kind   OfflineLeasePlanKind
	Lease  OfflineLeaseRecord
	Reason DenialReason
}

func EvaluateSubscriptionFacts(facts billing.SubscriptionFacts, checkedAt int64) SubscriptionEvaluation {
	if !validTimestamp(checkedAt) || !validFactsTimeline(facts) {
		return SubscriptionEvaluation{Kind: EvaluationInvalid}
	}
	scheduledEnd := facts.CancelAt
	switch facts.Lifecycle.Kind {
	case billing.LifecycleCheckoutPending:
		reason := LockPaymentMethodRequired
		if facts.PaymentMethodReady {
			reason = LockCheckoutIncomplete
		}
		return locked(reason)
	case billing.LifecycleTrialing:
		if !facts.PaymentMethodReady {
			return locked(LockPaymentMethodRequired)
		}
		validUntil := effectiveEnd(facts.Lifecycle.TrialEndsAt, scheduledEnd)
		if checkedAt < validUntil {
			return SubscriptionEvaluation{Kind: EvaluationEvaluated, State: State{Kind: StateTrialActive, ValidUntil: validUntil}}
		}
		if scheduledEnd != nil && *scheduledEnd <= checkedAt {
			return locked(LockCancelled)
		}
		return locked(LockTrialExpired)
	case billing.LifecycleActive:
		if !facts.PaymentMethodReady {
			return locked(LockPaymentMethodRequired)
		}
		validUntil := effectiveEnd(facts.Lifecycle.PaidThrough, scheduledEnd)
		if checkedAt < validUntil {
			return SubscriptionEvaluation{Kind: EvaluationEvaluated, State: State{Kind: StatePaidActive, ValidUntil: validUntil}}
		}
		if scheduledEnd != nil && *scheduledEnd <= checkedAt {
			return locked(LockCancelled)
		}
		return locked(LockPaidPeriodExpired)
	case billing.LifecycleDelinquent:
		if facts.Lifecycle.DelinquencyReason == billing.DelinquencyPaymentFailed {
			return locked(LockPaymentFailed)
		}
		return locked(LockPaymentActionRequired)
	case billing.LifecycleCancelled:
		return locked(LockCancelled)
	default:
		return SubscriptionEvaluation{Kind: EvaluationInvalid}
	}
}

func AuthorizeState(state State, capability Capability, checkedAt int64) Decision {
	if !validCapability(capability) || !validTimestamp(checkedAt) || !validStateShape(state) {
		return denied(capability, DenialInvalidInput)
	}
	if !isContentCapability(capability) {
		return Decision{Kind: DecisionAllowed, Capability: capability, Basis: BasisRecovery}
	}
	switch state.Kind {
	case StateTrialActive:
		if checkedAt < state.ValidUntil {
			return Decision{Kind: DecisionAllowed, Capability: capability, Basis: BasisTrial, ValidUntil: pointer(state.ValidUntil)}
		}
		return denied(capability, DenialReason(LockTrialExpired))
	case StatePaidActive:
		if checkedAt < state.ValidUntil {
			return Decision{Kind: DecisionAllowed, Capability: capability, Basis: BasisPaid, ValidUntil: pointer(state.ValidUntil)}
		}
		return denied(capability, DenialReason(LockPaidPeriodExpired))
	case StateLocked:
		if !validLockReason(state.Reason) {
			return denied(capability, DenialInvalidInput)
		}
		return denied(capability, DenialReason(state.Reason))
	default:
		return denied(capability, DenialInvalidInput)
	}
}

func PlanProjection(
	context identity.VaultContext,
	facts billing.SubscriptionFacts,
	state State,
	checkedAt int64,
	current *ProjectionRecord,
) ProjectionPlan {
	if !ValidVaultContext(context) || !validTimestamp(checkedAt) || !validFactsTimeline(facts) ||
		facts.AccountID != context.AccountID || facts.VaultID != context.VaultID || !validStateForPlan(state, checkedAt) {
		return ProjectionPlan{Kind: ProjectionInvalid}
	}
	if current != nil && (!ValidProjectionRecord(*current) || current.AccountID != context.AccountID ||
		current.VaultID != context.VaultID || current.SourceSubscriptionID != facts.SubscriptionID) {
		return ProjectionPlan{Kind: ProjectionInvalid}
	}
	if current != nil && (current.SourceBillingVersion > facts.Version || current.CheckedAt > checkedAt) {
		return ProjectionPlan{Kind: ProjectionStale}
	}
	if current != nil && current.SourceBillingVersion == facts.Version && current.CheckedAt == checkedAt && sameState(current.State, state) {
		return ProjectionPlan{Kind: ProjectionCurrent, Record: *current}
	}
	version, ok := nextProjectionVersion(current)
	if !ok {
		return ProjectionPlan{Kind: ProjectionInvalid}
	}
	createdAt := checkedAt
	if current != nil {
		createdAt = current.CreatedAt
	}
	record := ProjectionRecord{
		AccountID: context.AccountID, VaultID: context.VaultID, Version: version,
		SourceSubscriptionID: facts.SubscriptionID, SourceBillingVersion: facts.Version,
		State: state, CheckedAt: checkedAt, CreatedAt: createdAt, UpdatedAt: checkedAt,
	}
	if !ValidProjectionRecord(record) {
		return ProjectionPlan{Kind: ProjectionInvalid}
	}
	return ProjectionPlan{Kind: ProjectionCommit, Record: record}
}

func PlanOfflineLease(
	context identity.VaultContext,
	projection ProjectionRecord,
	policy OfflineLeasePolicy,
	leaseID OfflineLeaseID,
	issuedAt int64,
) OfflineLeasePlan {
	if !ValidVaultContext(context) || !ValidProjectionRecord(projection) || !validPolicy(policy) || !validTimestamp(issuedAt) ||
		projection.AccountID != context.AccountID || projection.VaultID != context.VaultID {
		return OfflineLeasePlan{Kind: OfflineLeaseDeny, Reason: DenialInvalidInput}
	}
	if _, err := ParseOfflineLeaseID(string(leaseID)); err != nil {
		return OfflineLeasePlan{Kind: OfflineLeaseDeny, Reason: DenialInvalidInput}
	}
	if policy.Kind == OfflineLeaseUndecided {
		return OfflineLeasePlan{Kind: OfflineLeaseDeny, Reason: DenialLeasePolicyUndecided}
	}
	if projection.State.Kind == StateLocked {
		return OfflineLeasePlan{Kind: OfflineLeaseDeny, Reason: DenialReason(projection.State.Reason)}
	}
	if issuedAt >= projection.State.ValidUntil {
		reason := DenialTrialExpired
		if projection.State.Kind == StatePaidActive {
			reason = DenialPaidPeriodExpired
		}
		return OfflineLeasePlan{Kind: OfflineLeaseDeny, Reason: reason}
	}
	if issuedAt > MaximumSafeInteger-policy.Duration {
		return OfflineLeasePlan{Kind: OfflineLeaseDeny, Reason: DenialInvalidInput}
	}
	expiresAt := issuedAt + policy.Duration
	if projection.State.ValidUntil < expiresAt {
		expiresAt = projection.State.ValidUntil
	}
	lease := OfflineLeaseRecord{
		OfflineLease: OfflineLease{
			LeaseID: leaseID, Context: context, Basis: basisFromState(projection.State),
			IssuedAt: issuedAt, ExpiresAt: expiresAt,
		},
		SourceSubscriptionID: projection.SourceSubscriptionID,
		SourceBillingVersion: projection.SourceBillingVersion,
	}
	if !ValidOfflineLeaseRecord(lease) {
		return OfflineLeasePlan{Kind: OfflineLeaseDeny, Reason: DenialInvalidInput}
	}
	return OfflineLeasePlan{Kind: OfflineLeaseIssue, Lease: lease}
}

const (
	DenialTrialExpired      DenialReason = DenialReason(LockTrialExpired)
	DenialPaidPeriodExpired DenialReason = DenialReason(LockPaidPeriodExpired)
)

func AuthorizeOfflineLease(
	lease OfflineLease,
	context identity.VaultContext,
	capability Capability,
	checkedAt int64,
) Decision {
	if !validCapability(capability) || !validTimestamp(checkedAt) || !validOfflineLease(lease) || !ValidVaultContext(context) {
		return denied(capability, DenialInvalidInput)
	}
	if !sameContext(lease.Context, context) {
		return denied(capability, DenialLeaseScopeMismatch)
	}
	if capability != CapabilityNotesRead && capability != CapabilityNotesWrite {
		return denied(capability, DenialOnlineRequired)
	}
	if lease.RevokedAt != nil && *lease.RevokedAt <= checkedAt {
		return denied(capability, DenialLeaseRevoked)
	}
	if checkedAt >= lease.ExpiresAt {
		return denied(capability, DenialLeaseExpired)
	}
	return Decision{Kind: DecisionAllowed, Capability: capability, Basis: lease.Basis, ValidUntil: pointer(lease.ExpiresAt)}
}

func locked(reason LockReason) SubscriptionEvaluation {
	return SubscriptionEvaluation{Kind: EvaluationEvaluated, State: State{Kind: StateLocked, Reason: reason}}
}

func effectiveEnd(periodEnd int64, cancelAt *int64) int64 {
	if cancelAt != nil && *cancelAt < periodEnd {
		return *cancelAt
	}
	return periodEnd
}

func validFactsTimeline(facts billing.SubscriptionFacts) bool {
	if _, err := billing.ParseSubscriptionID(string(facts.SubscriptionID)); err != nil {
		return false
	}
	if _, err := identity.ParseAccountID(string(facts.AccountID)); err != nil {
		return false
	}
	if _, err := identity.ParseVaultID(string(facts.VaultID)); err != nil {
		return false
	}
	if _, err := billing.ParseVersion(int64(facts.Version)); err != nil {
		return false
	}
	if !validTimestamp(facts.UpdatedAt) || facts.CancelAt != nil && !validTimestamp(*facts.CancelAt) {
		return false
	}
	switch facts.Lifecycle.Kind {
	case billing.LifecycleCheckoutPending:
		return true
	case billing.LifecycleTrialing:
		return validTimestamp(facts.Lifecycle.TrialStartedAt) && validTimestamp(facts.Lifecycle.TrialEndsAt) &&
			facts.Lifecycle.TrialEndsAt > facts.Lifecycle.TrialStartedAt
	case billing.LifecycleActive:
		return validTimestamp(facts.Lifecycle.PaidPeriodStartedAt) && validTimestamp(facts.Lifecycle.PaidThrough) &&
			facts.Lifecycle.PaidThrough > facts.Lifecycle.PaidPeriodStartedAt
	case billing.LifecycleDelinquent:
		if facts.Lifecycle.DelinquencyReason != billing.DelinquencyPaymentFailed &&
			facts.Lifecycle.DelinquencyReason != billing.DelinquencyPaymentActionRequired {
			return false
		}
		_, err := billing.ParseProviderInvoiceReference(string(facts.Lifecycle.InvoiceReference))
		return err == nil && validTimestamp(facts.Lifecycle.DelinquencySince)
	case billing.LifecycleCancelled:
		return validTimestamp(facts.Lifecycle.CancelledAt)
	default:
		return false
	}
}

func validStateForPlan(state State, checkedAt int64) bool {
	return validStateShape(state) && (state.Kind == StateLocked || state.ValidUntil > checkedAt)
}

func validOfflineLease(lease OfflineLease) bool {
	return validPublicOfflineLease(lease)
}

func sameState(left State, right State) bool {
	return left.Kind == right.Kind && left.ValidUntil == right.ValidUntil && left.Reason == right.Reason
}

func sameContext(left identity.VaultContext, right identity.VaultContext) bool {
	return left.AccountID == right.AccountID && left.VaultID == right.VaultID &&
		left.SessionID == right.SessionID && left.SessionEpoch == right.SessionEpoch
}

func nextProjectionVersion(current *ProjectionRecord) (ProjectionVersion, bool) {
	if current == nil {
		return 1, true
	}
	next := int64(current.Version) + 1
	version, err := ParseProjectionVersion(next)
	return version, err == nil
}

func basisFromState(state State) Basis {
	if state.Kind == StateTrialActive {
		return BasisTrial
	}
	return BasisPaid
}

func isContentCapability(capability Capability) bool {
	return capability == CapabilityNotesRead || capability == CapabilityNotesWrite || capability == CapabilityNotesSync
}

func denied(capability Capability, reason DenialReason) Decision {
	return Decision{Kind: DecisionDenied, Capability: capability, Reason: reason}
}
