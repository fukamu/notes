package billing

import "github.com/fukamu/notes/backend/internal/identity"

func ValidRecord(record SubscriptionRecord) bool {
	if _, err := ParseSubscriptionID(string(record.SubscriptionID)); err != nil {
		return false
	}
	if _, err := identity.ParseAccountID(string(record.AccountID)); err != nil {
		return false
	}
	if _, err := identity.ParseVaultID(string(record.VaultID)); err != nil {
		return false
	}
	if _, err := ParseProvider(string(record.Provider)); err != nil {
		return false
	}
	if _, err := ParseVersion(int64(record.Version)); err != nil {
		return false
	}
	if !validTimestamp(record.CreatedAt) || !validTimestamp(record.UpdatedAt) || record.UpdatedAt < record.CreatedAt ||
		!validOptionalTimestamp(record.PaymentMethodUpdatedAt) || !validOptionalTimestamp(record.TrialObservedAt) ||
		!validOptionalTimestamp(record.LastPaidAt) || !validOptionalTimestamp(record.LastDelinquencyAt) ||
		!validOptionalTimestamp(record.CancellationUpdatedAt) || !validOptionalTimestamp(record.CancelAt) ||
		!validOptionalTimestamp(record.LastReconciledAt) {
		return false
	}
	if (record.ProviderCustomerReference == "") != (record.ProviderSubscriptionReference == "") {
		return false
	}
	if record.ProviderCustomerReference != "" {
		if _, err := ParseProviderCustomerReference(string(record.ProviderCustomerReference)); err != nil {
			return false
		}
		if _, err := ParseProviderSubscriptionReference(string(record.ProviderSubscriptionReference)); err != nil {
			return false
		}
	}
	if (record.LastPaidAt == nil) != (record.LastPaidInvoiceReference == "") {
		return false
	}
	if record.LastPaidInvoiceReference != "" {
		if _, err := ParseProviderInvoiceReference(string(record.LastPaidInvoiceReference)); err != nil {
			return false
		}
	}
	if !validLifecycle(record.Lifecycle) {
		return false
	}
	switch record.Lifecycle.Kind {
	case LifecycleCheckoutPending:
		return record.TrialObservedAt == nil && record.LastPaidAt == nil && record.LastDelinquencyAt == nil
	case LifecycleTrialing:
		return record.PaymentMethodReady && record.TrialObservedAt != nil && record.LastPaidAt == nil &&
			record.LastDelinquencyAt == nil
	case LifecycleActive:
		return record.LastPaidAt != nil && record.LastDelinquencyAt == nil
	case LifecycleDelinquent:
		return record.LastDelinquencyAt != nil && *record.LastDelinquencyAt == record.Lifecycle.DelinquencySince
	case LifecycleCancelled:
		return true
	default:
		return false
	}
}

func validLifecycle(lifecycle Lifecycle) bool {
	switch lifecycle.Kind {
	case LifecycleCheckoutPending:
		return lifecycle == (Lifecycle{Kind: LifecycleCheckoutPending})
	case LifecycleTrialing:
		return validTimestamp(lifecycle.TrialStartedAt) && validTimestamp(lifecycle.TrialEndsAt) &&
			lifecycle.TrialEndsAt > lifecycle.TrialStartedAt && lifecycle.PaidPeriodStartedAt == 0 &&
			lifecycle.PaidThrough == 0 && lifecycle.DelinquencyReason == "" && lifecycle.DelinquencySince == 0 &&
			lifecycle.InvoiceReference == "" && lifecycle.CancelledAt == 0
	case LifecycleActive:
		return validTimestamp(lifecycle.PaidPeriodStartedAt) && validTimestamp(lifecycle.PaidThrough) &&
			lifecycle.PaidThrough > lifecycle.PaidPeriodStartedAt && lifecycle.TrialStartedAt == 0 &&
			lifecycle.TrialEndsAt == 0 && lifecycle.DelinquencyReason == "" && lifecycle.DelinquencySince == 0 &&
			lifecycle.InvoiceReference == "" && lifecycle.CancelledAt == 0
	case LifecycleDelinquent:
		return validDelinquencyReason(lifecycle.DelinquencyReason) && validTimestamp(lifecycle.DelinquencySince) &&
			validProviderReference(string(lifecycle.InvoiceReference)) && lifecycle.TrialStartedAt == 0 &&
			lifecycle.TrialEndsAt == 0 && lifecycle.PaidPeriodStartedAt == 0 && lifecycle.PaidThrough == 0 &&
			lifecycle.CancelledAt == 0
	case LifecycleCancelled:
		return validTimestamp(lifecycle.CancelledAt) && lifecycle.TrialStartedAt == 0 && lifecycle.TrialEndsAt == 0 &&
			lifecycle.PaidPeriodStartedAt == 0 && lifecycle.PaidThrough == 0 && lifecycle.DelinquencyReason == "" &&
			lifecycle.DelinquencySince == 0 && lifecycle.InvoiceReference == ""
	default:
		return false
	}
}

func validCheckoutCommand(command BeginCheckoutCommand) bool {
	_, subscriptionErr := ParseSubscriptionID(string(command.SubscriptionID))
	_, checkoutErr := ParseCheckoutIntentID(string(command.CheckoutID))
	_, providerErr := ParseProvider(string(command.Provider))
	return subscriptionErr == nil && checkoutErr == nil && providerErr == nil
}

func validProviderFact(fact VerifiedProviderFact) bool {
	if _, err := ParseSubscriptionID(string(fact.SubscriptionID)); err != nil {
		return false
	}
	if _, err := ParseProvider(string(fact.Provider)); err != nil {
		return false
	}
	if _, err := ParseProviderEventID(string(fact.EventID)); err != nil {
		return false
	}
	if _, err := ParseProviderCustomerReference(string(fact.ProviderCustomerReference)); err != nil {
		return false
	}
	if _, err := ParseProviderSubscriptionReference(string(fact.ProviderSubscriptionReference)); err != nil {
		return false
	}
	if !validTimestamp(fact.OccurredAt) || !validTimestamp(fact.RecordedAt) || fact.RecordedAt < fact.OccurredAt {
		return false
	}
	switch fact.Kind {
	case FactTrialStarted:
		return validTimestamp(fact.TrialStartedAt) && validTimestamp(fact.TrialEndsAt) &&
			fact.TrialEndsAt-fact.TrialStartedAt == TrialDurationMilliseconds
	case FactPaymentMethodUpdated:
		return true
	case FactInvoicePaid:
		return validProviderReference(string(fact.InvoiceReference)) && validTimestamp(fact.PaidPeriodStartedAt) &&
			validTimestamp(fact.PaidPeriodEndsAt) && fact.PaidPeriodEndsAt > fact.PaidPeriodStartedAt
	case FactInvoicePaymentFailed, FactInvoicePaymentActionRequired:
		return validProviderReference(string(fact.InvoiceReference))
	case FactCancellationScheduled:
		return validTimestamp(fact.CancelAt) && fact.CancelAt >= fact.OccurredAt
	case FactSubscriptionCancelled:
		return validTimestamp(fact.CancelledAt) && fact.CancelledAt >= fact.OccurredAt
	default:
		return false
	}
}

func validSnapshot(snapshot ReconciliationSnapshot) bool {
	if _, err := ParseReconciliationSnapshotID(string(snapshot.SnapshotID)); err != nil {
		return false
	}
	if _, err := ParseSubscriptionID(string(snapshot.SubscriptionID)); err != nil {
		return false
	}
	if _, err := ParseProvider(string(snapshot.Provider)); err != nil {
		return false
	}
	if _, err := ParseProviderCustomerReference(string(snapshot.ProviderCustomerReference)); err != nil {
		return false
	}
	if _, err := ParseProviderSubscriptionReference(string(snapshot.ProviderSubscriptionReference)); err != nil {
		return false
	}
	if !validTimestamp(snapshot.ObservedAt) || !validTimestamp(snapshot.RecordedAt) || snapshot.RecordedAt < snapshot.ObservedAt ||
		!validTimestamp(snapshot.PaymentMethodUpdatedAt) || !validTimestamp(snapshot.CancellationUpdatedAt) ||
		!validOptionalTimestamp(snapshot.CancelAt) || !validOptionalTimestamp(snapshot.CancelledAt) {
		return false
	}
	if snapshot.Trial != nil && (!snapshot.PaymentMethodReady || !validTimestamp(snapshot.Trial.StartedAt) ||
		!validTimestamp(snapshot.Trial.EndsAt) || !validTimestamp(snapshot.Trial.ObservedAt) ||
		snapshot.Trial.EndsAt-snapshot.Trial.StartedAt != TrialDurationMilliseconds) {
		return false
	}
	if snapshot.LatestPaidInvoice != nil && (!validProviderReference(string(snapshot.LatestPaidInvoice.InvoiceReference)) ||
		!validTimestamp(snapshot.LatestPaidInvoice.PaidAt) || !validTimestamp(snapshot.LatestPaidInvoice.PeriodStartedAt) ||
		!validTimestamp(snapshot.LatestPaidInvoice.PeriodEndsAt) ||
		snapshot.LatestPaidInvoice.PeriodEndsAt <= snapshot.LatestPaidInvoice.PeriodStartedAt) {
		return false
	}
	if snapshot.Delinquency != nil && (!validDelinquencyReason(snapshot.Delinquency.Reason) ||
		!validProviderReference(string(snapshot.Delinquency.InvoiceReference)) || !validTimestamp(snapshot.Delinquency.OccurredAt)) {
		return false
	}
	return true
}

func validDelinquencyReason(reason DelinquencyReason) bool {
	return reason == DelinquencyPaymentFailed || reason == DelinquencyPaymentActionRequired
}

func validOptionalTimestamp(value *int64) bool {
	return value == nil || validTimestamp(*value)
}
