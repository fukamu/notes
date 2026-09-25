package billing

import (
	"strconv"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

func TestCheckoutAndProviderFactOrdering(t *testing.T) {
	record := checkoutRecord(t)
	if record.Lifecycle.Kind != LifecycleCheckoutPending || record.PaymentMethodReady || record.Version != 1 {
		t.Fatalf("checkout record = %#v", record)
	}

	trial := requireApplied(t, record, providerFact(FactTrialStarted, 2_000))
	if trial.Lifecycle.Kind != LifecycleTrialing || !trial.PaymentMethodReady || trial.Version != 2 {
		t.Fatalf("trial record = %#v", trial)
	}
	failed := requireApplied(t, trial, providerFact(FactInvoicePaymentFailed, 5_000))
	if failed.Lifecycle.Kind != LifecycleDelinquent || failed.Lifecycle.DelinquencyReason != DelinquencyPaymentFailed {
		t.Fatalf("failed record = %#v", failed)
	}
	updated := requireApplied(t, failed, providerFact(FactPaymentMethodUpdated, 6_000))
	if updated.Lifecycle.Kind != LifecycleDelinquent {
		t.Fatalf("card update unlocked delinquency: %#v", updated)
	}
	oldPaid := requireApplied(t, updated, providerFact(FactInvoicePaid, 4_000))
	if oldPaid.Lifecycle.Kind != LifecycleDelinquent {
		t.Fatalf("old paid fact unlocked delinquency: %#v", oldPaid)
	}
	currentPaid := requireApplied(t, oldPaid, providerFact(FactInvoicePaid, 7_000))
	if currentPaid.Lifecycle.Kind != LifecycleActive || currentPaid.Lifecycle.PaidThrough != 17_000 {
		t.Fatalf("current paid record = %#v", currentPaid)
	}
}

func TestSameTimeDelinquencyDominatesInEitherOrder(t *testing.T) {
	trial := requireApplied(t, checkoutRecord(t), providerFact(FactTrialStarted, 2_000))
	paidFirst := requireApplied(t, trial, providerFact(FactInvoicePaid, 5_000))
	failedSecond := requireApplied(t, paidFirst, providerFact(FactInvoicePaymentFailed, 5_000))
	if failedSecond.Lifecycle.Kind != LifecycleDelinquent {
		t.Fatalf("paid then failed = %#v", failedSecond.Lifecycle)
	}

	failedFirst := requireApplied(t, trial, providerFact(FactInvoicePaymentActionRequired, 5_000))
	paidSecond := requireApplied(t, failedFirst, providerFact(FactInvoicePaid, 5_000))
	if paidSecond.Lifecycle.Kind != LifecycleDelinquent {
		t.Fatalf("failed then paid = %#v", paidSecond.Lifecycle)
	}
}

func TestReconciliationAllowsDistinctSameMillisecondSnapshots(t *testing.T) {
	failed := requireApplied(t, checkoutRecord(t), providerFact(FactInvoicePaymentFailed, 5_000))
	first := reconciliationSnapshot("snapshot-a", 8_000)
	firstPlan := PlanReconciliationSnapshot(failed, first)
	if firstPlan.Kind != ProviderFactApply || firstPlan.Record.Lifecycle.Kind != LifecycleActive {
		t.Fatalf("first reconciliation = %#v", firstPlan)
	}
	second := reconciliationSnapshot("snapshot-b", 8_000)
	second.LatestPaidInvoice = nil
	second.Delinquency = &ReconciliationDelinquency{
		Reason: DelinquencyPaymentActionRequired, InvoiceReference: "in_same_time_failure", OccurredAt: 8_000,
	}
	secondPlan := PlanReconciliationSnapshot(firstPlan.Record, second)
	if secondPlan.Kind != ProviderFactApply || secondPlan.Record.Lifecycle.Kind != LifecycleDelinquent {
		t.Fatalf("same-time distinct reconciliation = %#v", secondPlan)
	}

	older := reconciliationSnapshot("snapshot-older", 7_999)
	if plan := PlanReconciliationSnapshot(secondPlan.Record, older); plan.Kind != ProviderFactIgnore || plan.Reason != ReasonStale {
		t.Fatalf("older reconciliation = %#v", plan)
	}
}

func TestCancellationIsTerminalAndMappingsAreFailClosed(t *testing.T) {
	trial := requireApplied(t, checkoutRecord(t), providerFact(FactTrialStarted, 2_000))
	scheduled := requireApplied(t, trial, providerFact(FactCancellationScheduled, 7_000))
	if scheduled.CancelAt == nil || *scheduled.CancelAt != 12_000 {
		t.Fatalf("scheduled record = %#v", scheduled)
	}
	cancelled := requireApplied(t, scheduled, providerFact(FactSubscriptionCancelled, 12_000))
	if cancelled.Lifecycle.Kind != LifecycleCancelled {
		t.Fatalf("cancelled record = %#v", cancelled)
	}
	if plan := PlanVerifiedProviderFact(cancelled, providerFact(FactInvoicePaid, 13_000)); plan.Kind != ProviderFactIgnore || plan.Reason != ReasonTerminal {
		t.Fatalf("post-cancel fact = %#v", plan)
	}

	wrongProvider := providerFact(FactInvoicePaid, 13_000)
	wrongProvider.Provider = "other"
	if plan := PlanVerifiedProviderFact(trial, wrongProvider); plan.Kind != ProviderFactRejected || plan.Reason != ReasonProviderMismatch {
		t.Fatalf("provider mismatch = %#v", plan)
	}
	wrongMapping := providerFact(FactInvoicePaid, 13_000)
	wrongMapping.ProviderCustomerReference = "cus_other"
	if plan := PlanVerifiedProviderFact(trial, wrongMapping); plan.Kind != ProviderFactRejected || plan.Reason != ReasonMappingMismatch {
		t.Fatalf("mapping mismatch = %#v", plan)
	}
}

func TestInvalidTimelineAndInputRemainRejectedWithoutMutation(t *testing.T) {
	record := checkoutRecord(t)
	before := cloneRecord(record)
	invalid := providerFact(FactTrialStarted, 2_000)
	invalid.TrialEndsAt--
	plan := PlanVerifiedProviderFact(record, invalid)
	if plan.Kind != ProviderFactRejected || plan.Reason != ReasonInvalidTransition {
		t.Fatalf("invalid trial = %#v", plan)
	}
	if !equalRecord(record, before) {
		t.Fatal("planner mutated caller-owned record")
	}

	command := checkoutCommand()
	command.CreatedAt = -1
	if plan := PlanCheckoutCreation(ownerScope(t), command); plan.Kind != CheckoutPlanRejected {
		t.Fatalf("invalid checkout = %#v", plan)
	}
}

func checkoutRecord(t *testing.T) SubscriptionRecord {
	t.Helper()
	plan := PlanCheckoutCreation(ownerScope(t), checkoutCommand())
	if plan.Kind != CheckoutPlanCreate {
		t.Fatalf("checkout plan = %#v", plan)
	}
	return plan.Record
}

func checkoutCommand() BeginCheckoutCommand {
	return BeginCheckoutCommand{
		SubscriptionID: "01991f20-61d2-7000-8000-000000000701",
		CheckoutID:     "01991f20-61d2-7000-8000-000000000702",
		Provider:       "stripe",
		CreatedAt:      1_000,
	}
}

func ownerScope(t *testing.T) OwnerScope {
	t.Helper()
	accountID, accountErr := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	vaultID, vaultErr := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	if accountErr != nil || vaultErr != nil {
		t.Fatal(accountErr, vaultErr)
	}
	return OwnerScope{AccountID: accountID, VaultID: vaultID}
}

func providerFact(kind FactKind, occurredAt int64) VerifiedProviderFact {
	fact := VerifiedProviderFact{
		Kind: kind, SubscriptionID: checkoutCommand().SubscriptionID, Provider: "stripe",
		EventID: ProviderEventID("evt_" + string(kind)), ProviderCustomerReference: "cus_notes",
		ProviderSubscriptionReference: "sub_notes", OccurredAt: occurredAt, RecordedAt: occurredAt + 100,
	}
	switch kind {
	case FactTrialStarted:
		fact.TrialStartedAt = 2_000
		fact.TrialEndsAt = 2_000 + TrialDurationMilliseconds
	case FactInvoicePaid:
		fact.InvoiceReference = ProviderInvoiceReference("in_paid_" + strconv.FormatInt(occurredAt, 10))
		fact.PaidPeriodStartedAt = occurredAt
		fact.PaidPeriodEndsAt = occurredAt + 10_000
	case FactInvoicePaymentFailed, FactInvoicePaymentActionRequired:
		fact.InvoiceReference = ProviderInvoiceReference("in_delinquent_" + string(kind))
	case FactCancellationScheduled:
		fact.CancelAt = 12_000
	case FactSubscriptionCancelled:
		fact.CancelledAt = occurredAt
	}
	return fact
}

func reconciliationSnapshot(id string, observedAt int64) ReconciliationSnapshot {
	return ReconciliationSnapshot{
		SnapshotID: ReconciliationSnapshotID(id), SubscriptionID: checkoutCommand().SubscriptionID,
		Provider: "stripe", ProviderCustomerReference: "cus_notes", ProviderSubscriptionReference: "sub_notes",
		ObservedAt: observedAt, RecordedAt: observedAt + 100, PaymentMethodReady: true,
		PaymentMethodUpdatedAt: observedAt, CancellationUpdatedAt: observedAt,
		LatestPaidInvoice: &ReconciliationPaidInvoice{
			InvoiceReference: "in_reconciled", PaidAt: observedAt,
			PeriodStartedAt: observedAt, PeriodEndsAt: observedAt + 10_000,
		},
	}
}

func requireApplied(t *testing.T, current SubscriptionRecord, fact VerifiedProviderFact) SubscriptionRecord {
	t.Helper()
	plan := PlanVerifiedProviderFact(current, fact)
	if plan.Kind != ProviderFactApply {
		t.Fatalf("expected apply, got %#v", plan)
	}
	return plan.Record
}
