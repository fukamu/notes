package entitlement

import (
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
)

func TestEvaluateSubscriptionFactsBoundaries(t *testing.T) {
	trial := trialFacts()
	trialEnd := trial.Lifecycle.TrialEndsAt
	if result := EvaluateSubscriptionFacts(trial, trialEnd-1); result.Kind != EvaluationEvaluated ||
		result.State.Kind != StateTrialActive || result.State.ValidUntil != trialEnd {
		t.Fatalf("trial before boundary = %#v", result)
	}
	if result := EvaluateSubscriptionFacts(trial, trialEnd); result.State.Reason != LockTrialExpired {
		t.Fatalf("trial at boundary = %#v", result)
	}

	active := testFacts(billing.Lifecycle{Kind: billing.LifecycleActive, PaidPeriodStartedAt: 10_000, PaidThrough: 20_000})
	if result := EvaluateSubscriptionFacts(active, 19_999); result.State.Kind != StatePaidActive || result.State.ValidUntil != 20_000 {
		t.Fatalf("paid before boundary = %#v", result)
	}
	if result := EvaluateSubscriptionFacts(active, 20_000); result.State.Reason != LockPaidPeriodExpired {
		t.Fatalf("paid at boundary = %#v", result)
	}

	notReady := trial
	notReady.PaymentMethodReady = false
	if result := EvaluateSubscriptionFacts(notReady, 3_000); result.State.Reason != LockPaymentMethodRequired {
		t.Fatalf("payment method = %#v", result)
	}
	cancelAt := int64(4_000)
	trial.CancelAt = &cancelAt
	if result := EvaluateSubscriptionFacts(trial, cancelAt); result.State.Reason != LockCancelled {
		t.Fatalf("scheduled cancellation = %#v", result)
	}
}

func TestAuthorizeStateKeepsRecoveryOpen(t *testing.T) {
	state := State{Kind: StateLocked, Reason: LockPaymentFailed}
	for _, capability := range []Capability{CapabilityNotesRead, CapabilityNotesWrite, CapabilityNotesSync} {
		decision := AuthorizeState(state, capability, 5_000)
		if decision.Kind != DecisionDenied || decision.Reason != DenialReason(LockPaymentFailed) {
			t.Fatalf("content %s = %#v", capability, decision)
		}
	}
	for _, capability := range []Capability{CapabilityBillingRecovery, CapabilitySubscriptionCancel, CapabilityAccountDelete, CapabilitySupport} {
		decision := AuthorizeState(state, capability, 5_000)
		if decision.Kind != DecisionAllowed || decision.Basis != BasisRecovery || decision.ValidUntil != nil {
			t.Fatalf("recovery %s = %#v", capability, decision)
		}
	}
}

func TestPlanProjectionRejectsStaleCrossOwnerAndVersionOverflow(t *testing.T) {
	context := testContext()
	facts := trialFacts()
	evaluation := EvaluateSubscriptionFacts(facts, 3_000)
	created := PlanProjection(context, facts, evaluation.State, 3_000, nil)
	if created.Kind != ProjectionCommit || created.Record.Version != 1 {
		t.Fatalf("created = %#v", created)
	}
	older := facts
	older.Version = 1
	if plan := PlanProjection(context, older, evaluation.State, 3_001, &created.Record); plan.Kind != ProjectionStale {
		t.Fatalf("older billing = %#v", plan)
	}
	other := facts
	other.AccountID = "01991f20-61d2-7000-8000-000000000102"
	if plan := PlanProjection(context, other, evaluation.State, 3_001, &created.Record); plan.Kind != ProjectionInvalid {
		t.Fatalf("cross owner = %#v", plan)
	}
	overflow := created.Record
	overflow.Version = 2_147_483_647
	if plan := PlanProjection(context, facts, evaluation.State, 3_001, &overflow); plan.Kind != ProjectionInvalid {
		t.Fatalf("version overflow = %#v", plan)
	}
}

func TestOfflineLeasePolicyScopeAndExclusiveExpiry(t *testing.T) {
	context := testContext()
	facts := trialFacts()
	evaluation := EvaluateSubscriptionFacts(facts, 3_000)
	projection := PlanProjection(context, facts, evaluation.State, 3_000, nil)
	undecided := PlanOfflineLease(context, projection.Record, OfflineLeasePolicy{Kind: OfflineLeaseUndecided}, testLeaseA, 3_000)
	if undecided.Kind != OfflineLeaseDeny || undecided.Reason != DenialLeasePolicyUndecided {
		t.Fatalf("undecided = %#v", undecided)
	}
	planned := PlanOfflineLease(context, projection.Record, FukamuOfflineLeasePolicy(), testLeaseA, 3_000)
	if planned.Kind != OfflineLeaseIssue || planned.Lease.ExpiresAt != 3_000+OfflineLeaseDurationMilliseconds {
		t.Fatalf("planned = %#v", planned)
	}
	otherSession := context
	otherSession.SessionID = "01991f20-61d2-7000-8000-000000000302"
	if decision := AuthorizeOfflineLease(planned.Lease.OfflineLease, otherSession, CapabilityNotesRead, 4_000); decision.Reason != DenialLeaseScopeMismatch {
		t.Fatalf("scope = %#v", decision)
	}
	if decision := AuthorizeOfflineLease(planned.Lease.OfflineLease, context, CapabilityNotesSync, 4_000); decision.Reason != DenialOnlineRequired {
		t.Fatalf("online = %#v", decision)
	}
	if decision := AuthorizeOfflineLease(planned.Lease.OfflineLease, context, CapabilityNotesWrite, planned.Lease.ExpiresAt-1); decision.Kind != DecisionAllowed {
		t.Fatalf("before expiry = %#v", decision)
	}
	if decision := AuthorizeOfflineLease(planned.Lease.OfflineLease, context, CapabilityNotesWrite, planned.Lease.ExpiresAt); decision.Reason != DenialLeaseExpired {
		t.Fatalf("at expiry = %#v", decision)
	}
}

func TestOfflineLeaseIsCappedByBillingPeriod(t *testing.T) {
	context := testContext()
	facts := testFacts(billing.Lifecycle{Kind: billing.LifecycleActive, PaidPeriodStartedAt: 10_000, PaidThrough: 50_000})
	evaluation := EvaluateSubscriptionFacts(facts, 20_000)
	projection := PlanProjection(context, facts, evaluation.State, 20_000, nil)
	lease := PlanOfflineLease(context, projection.Record, FukamuOfflineLeasePolicy(), testLeaseB, 20_000)
	if lease.Kind != OfflineLeaseIssue || lease.Lease.ExpiresAt != 50_000 || lease.Lease.Basis != BasisPaid {
		t.Fatalf("billing cap = %#v", lease)
	}
}
