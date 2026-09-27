package billing

type CheckoutPlanKind string

const (
	CheckoutPlanCreate   CheckoutPlanKind = "create"
	CheckoutPlanRejected CheckoutPlanKind = "rejected"
)

type PlanReason string

const (
	ReasonInvalidTransition PlanReason = "invalid-transition"
	ReasonProviderMismatch  PlanReason = "provider-mismatch"
	ReasonMappingMismatch   PlanReason = "mapping-mismatch"
	ReasonStale             PlanReason = "stale"
	ReasonTerminal          PlanReason = "terminal"
	ReasonNoChange          PlanReason = "no-change"
)

type CheckoutCreationPlan struct {
	Kind   CheckoutPlanKind
	Reason PlanReason
	Record SubscriptionRecord
}

type ProviderFactPlanKind string

const (
	ProviderFactApply    ProviderFactPlanKind = "apply"
	ProviderFactIgnore   ProviderFactPlanKind = "ignore"
	ProviderFactRejected ProviderFactPlanKind = "rejected"
)

type ProviderFactPlan struct {
	Kind   ProviderFactPlanKind
	Reason PlanReason
	Record SubscriptionRecord
}

func PlanCheckoutCreation(scope OwnerScope, command BeginCheckoutCommand) CheckoutCreationPlan {
	if !scope.Valid() || !validTimestamp(command.CreatedAt) || !validCheckoutCommand(command) {
		return CheckoutCreationPlan{Kind: CheckoutPlanRejected, Reason: ReasonInvalidTransition}
	}
	return CheckoutCreationPlan{
		Kind: CheckoutPlanCreate,
		Record: SubscriptionRecord{
			SubscriptionID: command.SubscriptionID,
			AccountID:      scope.AccountID,
			VaultID:        scope.VaultID,
			Provider:       command.Provider,
			Version:        1,
			Lifecycle:      Lifecycle{Kind: LifecycleCheckoutPending},
			CreatedAt:      command.CreatedAt,
			UpdatedAt:      command.CreatedAt,
		},
	}
}

func PlanVerifiedProviderFact(current SubscriptionRecord, fact VerifiedProviderFact) ProviderFactPlan {
	if !ValidRecord(current) || !validProviderFact(fact) {
		return rejected(ReasonInvalidTransition)
	}
	if current.SubscriptionID != fact.SubscriptionID {
		return rejected(ReasonMappingMismatch)
	}
	mapped, reason, ok := mapProviderReferences(
		current,
		fact.Provider,
		fact.ProviderCustomerReference,
		fact.ProviderSubscriptionReference,
	)
	if !ok {
		return rejected(reason)
	}
	if mapped.Lifecycle.Kind == LifecycleCancelled {
		return ignored(mapped, ReasonTerminal)
	}

	switch fact.Kind {
	case FactTrialStarted:
		return planTrialStarted(mapped, fact)
	case FactPaymentMethodUpdated:
		return planPaymentMethodUpdated(mapped, fact)
	case FactInvoicePaid:
		return planInvoicePaid(mapped, fact)
	case FactInvoicePaymentFailed:
		return planDelinquency(mapped, fact, DelinquencyPaymentFailed)
	case FactInvoicePaymentActionRequired:
		return planDelinquency(mapped, fact, DelinquencyPaymentActionRequired)
	case FactCancellationScheduled:
		return planCancellationScheduled(mapped, fact)
	case FactSubscriptionCancelled:
		mapped.Lifecycle = Lifecycle{Kind: LifecycleCancelled, CancelledAt: fact.CancelledAt}
		mapped.CancellationUpdatedAt = pointer(fact.OccurredAt)
		mapped.CancelAt = pointer(fact.CancelledAt)
		return applied(current, mapped, fact.RecordedAt)
	default:
		return rejected(ReasonInvalidTransition)
	}
}

func PlanReconciliationSnapshot(current SubscriptionRecord, snapshot ReconciliationSnapshot) ProviderFactPlan {
	if !ValidRecord(current) || !validSnapshot(snapshot) {
		return rejected(ReasonInvalidTransition)
	}
	if current.SubscriptionID != snapshot.SubscriptionID {
		return rejected(ReasonMappingMismatch)
	}
	mapped, reason, ok := mapProviderReferences(
		current,
		snapshot.Provider,
		snapshot.ProviderCustomerReference,
		snapshot.ProviderSubscriptionReference,
	)
	if !ok {
		return rejected(reason)
	}
	if mapped.Lifecycle.Kind == LifecycleCancelled {
		return ignored(mapped, ReasonTerminal)
	}
	// Equal observation times are intentionally accepted. Different provider
	// snapshots can be observed in the same millisecond; the durable snapshot
	// receipt handles exact replay while state evidence resolves by its own time.
	if mapped.LastReconciledAt != nil && snapshot.ObservedAt < *mapped.LastReconciledAt {
		return ignored(mapped, ReasonStale)
	}

	next := cloneRecord(mapped)
	if snapshot.Trial != nil &&
		(next.TrialObservedAt == nil || snapshot.Trial.ObservedAt > *next.TrialObservedAt) {
		next.TrialObservedAt = pointer(snapshot.Trial.ObservedAt)
		if next.Lifecycle.Kind == LifecycleCheckoutPending || next.Lifecycle.Kind == LifecycleTrialing {
			next.Lifecycle = Lifecycle{
				Kind: LifecycleTrialing, TrialStartedAt: snapshot.Trial.StartedAt, TrialEndsAt: snapshot.Trial.EndsAt,
			}
		}
	}
	if next.PaymentMethodUpdatedAt == nil || snapshot.PaymentMethodUpdatedAt > *next.PaymentMethodUpdatedAt {
		next.PaymentMethodReady = snapshot.PaymentMethodReady
		next.PaymentMethodUpdatedAt = pointer(snapshot.PaymentMethodUpdatedAt)
	}
	if snapshot.LatestPaidInvoice != nil {
		next = applyPaidEvidence(next, *snapshot.LatestPaidInvoice)
	}
	if snapshot.Delinquency != nil {
		next = applyDelinquencyEvidence(next, *snapshot.Delinquency)
	}
	if next.CancellationUpdatedAt == nil || snapshot.CancellationUpdatedAt > *next.CancellationUpdatedAt {
		next.CancelAt = cloneTimestamp(snapshot.CancelAt)
		next.CancellationUpdatedAt = pointer(snapshot.CancellationUpdatedAt)
	}
	if snapshot.CancelledAt != nil {
		next.Lifecycle = Lifecycle{Kind: LifecycleCancelled, CancelledAt: *snapshot.CancelledAt}
		next.CancelAt = pointer(*snapshot.CancelledAt)
		updatedAt := snapshot.CancellationUpdatedAt
		if *snapshot.CancelledAt > updatedAt {
			updatedAt = *snapshot.CancelledAt
		}
		next.CancellationUpdatedAt = pointer(updatedAt)
	}
	next.LastReconciledAt = pointer(snapshot.ObservedAt)
	if equalRecord(current, next) {
		return ignored(current, ReasonNoChange)
	}
	return applied(current, next, snapshot.RecordedAt)
}

func planTrialStarted(current SubscriptionRecord, fact VerifiedProviderFact) ProviderFactPlan {
	if current.TrialObservedAt != nil && fact.OccurredAt <= *current.TrialObservedAt {
		return ignored(current, ReasonStale)
	}
	if current.Lifecycle.Kind != LifecycleCheckoutPending && current.Lifecycle.Kind != LifecycleTrialing {
		return ignored(current, ReasonStale)
	}
	next := cloneRecord(current)
	next.Lifecycle = Lifecycle{Kind: LifecycleTrialing, TrialStartedAt: fact.TrialStartedAt, TrialEndsAt: fact.TrialEndsAt}
	next.PaymentMethodReady = true
	next.PaymentMethodUpdatedAt = later(current.PaymentMethodUpdatedAt, fact.OccurredAt)
	next.TrialObservedAt = pointer(fact.OccurredAt)
	return applied(current, next, fact.RecordedAt)
}

func planPaymentMethodUpdated(current SubscriptionRecord, fact VerifiedProviderFact) ProviderFactPlan {
	if current.PaymentMethodReady && current.PaymentMethodUpdatedAt != nil && fact.OccurredAt <= *current.PaymentMethodUpdatedAt {
		return ignored(current, ReasonNoChange)
	}
	next := cloneRecord(current)
	next.PaymentMethodReady = true
	next.PaymentMethodUpdatedAt = later(current.PaymentMethodUpdatedAt, fact.OccurredAt)
	return applied(current, next, fact.RecordedAt)
}

func planInvoicePaid(current SubscriptionRecord, fact VerifiedProviderFact) ProviderFactPlan {
	if current.LastPaidAt != nil && fact.OccurredAt <= *current.LastPaidAt {
		return ignored(current, ReasonStale)
	}
	next := applyPaidEvidence(current, ReconciliationPaidInvoice{
		InvoiceReference: fact.InvoiceReference,
		PaidAt:           fact.OccurredAt, PeriodStartedAt: fact.PaidPeriodStartedAt, PeriodEndsAt: fact.PaidPeriodEndsAt,
	})
	if equalRecord(current, next) {
		return ignored(current, ReasonNoChange)
	}
	return applied(current, next, fact.RecordedAt)
}

func planDelinquency(current SubscriptionRecord, fact VerifiedProviderFact, reason DelinquencyReason) ProviderFactPlan {
	if current.LastPaidAt != nil && fact.OccurredAt < *current.LastPaidAt {
		return ignored(current, ReasonStale)
	}
	if current.LastDelinquencyAt != nil && fact.OccurredAt < *current.LastDelinquencyAt {
		return ignored(current, ReasonStale)
	}
	next := cloneRecord(current)
	next.Lifecycle = Lifecycle{
		Kind: LifecycleDelinquent, DelinquencyReason: reason, DelinquencySince: fact.OccurredAt,
		InvoiceReference: fact.InvoiceReference,
	}
	next.LastDelinquencyAt = pointer(fact.OccurredAt)
	return applied(current, next, fact.RecordedAt)
}

func planCancellationScheduled(current SubscriptionRecord, fact VerifiedProviderFact) ProviderFactPlan {
	if current.CancellationUpdatedAt != nil && fact.OccurredAt <= *current.CancellationUpdatedAt {
		return ignored(current, ReasonStale)
	}
	next := cloneRecord(current)
	next.CancelAt = pointer(fact.CancelAt)
	next.CancellationUpdatedAt = pointer(fact.OccurredAt)
	return applied(current, next, fact.RecordedAt)
}

func applyPaidEvidence(current SubscriptionRecord, paid ReconciliationPaidInvoice) SubscriptionRecord {
	if current.LastPaidAt != nil && paid.PaidAt <= *current.LastPaidAt {
		return current
	}
	next := cloneRecord(current)
	newerThanDelinquency := current.LastDelinquencyAt == nil || paid.PaidAt > *current.LastDelinquencyAt
	if newerThanDelinquency {
		next.Lifecycle = Lifecycle{
			Kind: LifecycleActive, PaidPeriodStartedAt: paid.PeriodStartedAt, PaidThrough: paid.PeriodEndsAt,
		}
		next.LastDelinquencyAt = nil
	}
	next.LastPaidAt = pointer(paid.PaidAt)
	next.LastPaidInvoiceReference = paid.InvoiceReference
	return next
}

func applyDelinquencyEvidence(current SubscriptionRecord, delinquency ReconciliationDelinquency) SubscriptionRecord {
	if (current.LastPaidAt != nil && delinquency.OccurredAt < *current.LastPaidAt) ||
		(current.LastDelinquencyAt != nil && delinquency.OccurredAt < *current.LastDelinquencyAt) {
		return current
	}
	next := cloneRecord(current)
	next.Lifecycle = Lifecycle{
		Kind: LifecycleDelinquent, DelinquencyReason: delinquency.Reason,
		DelinquencySince: delinquency.OccurredAt, InvoiceReference: delinquency.InvoiceReference,
	}
	next.LastDelinquencyAt = pointer(delinquency.OccurredAt)
	return next
}

func mapProviderReferences(
	current SubscriptionRecord,
	provider Provider,
	customer ProviderCustomerReference,
	subscription ProviderSubscriptionReference,
) (SubscriptionRecord, PlanReason, bool) {
	if current.Provider != provider {
		return SubscriptionRecord{}, ReasonProviderMismatch, false
	}
	if (current.ProviderCustomerReference != "" && current.ProviderCustomerReference != customer) ||
		(current.ProviderSubscriptionReference != "" && current.ProviderSubscriptionReference != subscription) {
		return SubscriptionRecord{}, ReasonMappingMismatch, false
	}
	mapped := cloneRecord(current)
	mapped.ProviderCustomerReference = customer
	mapped.ProviderSubscriptionReference = subscription
	return mapped, "", true
}

func applied(original SubscriptionRecord, candidate SubscriptionRecord, recordedAt int64) ProviderFactPlan {
	candidate.Version = original.Version + 1
	if recordedAt > candidate.UpdatedAt {
		candidate.UpdatedAt = recordedAt
	}
	return ProviderFactPlan{Kind: ProviderFactApply, Record: candidate}
}

func ignored(record SubscriptionRecord, reason PlanReason) ProviderFactPlan {
	return ProviderFactPlan{Kind: ProviderFactIgnore, Reason: reason, Record: record}
}

func rejected(reason PlanReason) ProviderFactPlan {
	return ProviderFactPlan{Kind: ProviderFactRejected, Reason: reason}
}

func later(current *int64, candidate int64) *int64 {
	if current == nil || candidate > *current {
		return pointer(candidate)
	}
	return pointer(*current)
}

func cloneRecord(record SubscriptionRecord) SubscriptionRecord {
	clone := record
	clone.PaymentMethodUpdatedAt = cloneTimestamp(record.PaymentMethodUpdatedAt)
	clone.TrialObservedAt = cloneTimestamp(record.TrialObservedAt)
	clone.LastPaidAt = cloneTimestamp(record.LastPaidAt)
	clone.LastDelinquencyAt = cloneTimestamp(record.LastDelinquencyAt)
	clone.CancellationUpdatedAt = cloneTimestamp(record.CancellationUpdatedAt)
	clone.CancelAt = cloneTimestamp(record.CancelAt)
	clone.LastReconciledAt = cloneTimestamp(record.LastReconciledAt)
	return clone
}

func equalRecord(left SubscriptionRecord, right SubscriptionRecord) bool {
	return left.SubscriptionID == right.SubscriptionID && left.AccountID == right.AccountID && left.VaultID == right.VaultID &&
		left.Provider == right.Provider && left.ProviderCustomerReference == right.ProviderCustomerReference &&
		left.ProviderSubscriptionReference == right.ProviderSubscriptionReference && left.Version == right.Version &&
		left.Lifecycle == right.Lifecycle && left.PaymentMethodReady == right.PaymentMethodReady &&
		equalTimestamp(left.PaymentMethodUpdatedAt, right.PaymentMethodUpdatedAt) &&
		equalTimestamp(left.TrialObservedAt, right.TrialObservedAt) && equalTimestamp(left.LastPaidAt, right.LastPaidAt) &&
		left.LastPaidInvoiceReference == right.LastPaidInvoiceReference &&
		equalTimestamp(left.LastDelinquencyAt, right.LastDelinquencyAt) &&
		equalTimestamp(left.CancellationUpdatedAt, right.CancellationUpdatedAt) &&
		equalTimestamp(left.CancelAt, right.CancelAt) && equalTimestamp(left.LastReconciledAt, right.LastReconciledAt) &&
		left.CreatedAt == right.CreatedAt && left.UpdatedAt == right.UpdatedAt
}

func equalTimestamp(left *int64, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
