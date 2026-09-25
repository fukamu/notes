package billing

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

func TestSharedBillingProjectionFixture(t *testing.T) {
	content, err := os.ReadFile("../../../contracts/fixtures/billing/projection.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture billingProjectionFixture
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil || fixture.Profile != "billing-projection-v1" {
		t.Fatalf("decode fixture = %#v, %v", fixture, err)
	}
	accountID, _ := identity.ParseAccountID(fixture.Owner.AccountID)
	vaultID, _ := identity.ParseVaultID(fixture.Owner.VaultID)
	subscriptionID, _ := ParseSubscriptionID(fixture.Command.SubscriptionID)
	checkoutID, _ := ParseCheckoutIntentID(fixture.Command.CheckoutIntentID)
	provider, _ := ParseProvider(fixture.Command.Provider)
	plan := PlanCheckoutCreation(
		OwnerScope{AccountID: accountID, VaultID: vaultID},
		BeginCheckoutCommand{
			SubscriptionID: subscriptionID, CheckoutID: checkoutID, Provider: provider, CreatedAt: fixture.Command.CreatedAt,
		},
	)
	if plan.Kind != CheckoutPlanCreate {
		t.Fatalf("checkout plan = %#v", plan)
	}
	current := plan.Record
	for _, raw := range fixture.Facts {
		fact := fixtureProviderFact(t, fixture, raw, subscriptionID, provider)
		factPlan := PlanVerifiedProviderFact(current, fact)
		if factPlan.Kind != ProviderFactApply {
			t.Fatalf("fact %s = %#v", raw.Kind, factPlan)
		}
		current = factPlan.Record
	}
	for _, raw := range fixture.Snapshots {
		snapshot := fixtureSnapshot(t, fixture, raw, subscriptionID, provider)
		snapshotPlan := PlanReconciliationSnapshot(current, snapshot)
		if snapshotPlan.Kind != ProviderFactApply {
			t.Fatalf("snapshot %s = %#v", raw.SnapshotID, snapshotPlan)
		}
		current = snapshotPlan.Record
	}
	if int64(current.Version) != fixture.Expected.Version || string(current.Lifecycle.Kind) != fixture.Expected.Lifecycle ||
		string(current.Lifecycle.DelinquencyReason) != fixture.Expected.DelinquencyReason ||
		current.LastPaidAt == nil || *current.LastPaidAt != fixture.Expected.LastPaidAt ||
		current.LastDelinquencyAt == nil || *current.LastDelinquencyAt != fixture.Expected.LastDelinquencyAt ||
		current.LastReconciledAt == nil || *current.LastReconciledAt != fixture.Expected.LastReconciledAt {
		t.Fatalf("fixture result = %#v, expected %#v", current, fixture.Expected)
	}
}

type billingProjectionFixture struct {
	Profile string `json:"profile"`
	Owner   struct {
		AccountID string `json:"accountId"`
		VaultID   string `json:"vaultId"`
	} `json:"owner"`
	Command struct {
		SubscriptionID   string `json:"subscriptionId"`
		CheckoutIntentID string `json:"checkoutIntentId"`
		Provider         string `json:"provider"`
		CreatedAt        int64  `json:"createdAt"`
	} `json:"command"`
	Facts []struct {
		Kind                string `json:"kind"`
		EventID             string `json:"eventId"`
		OccurredAt          int64  `json:"occurredAt"`
		RecordedAt          int64  `json:"recordedAt"`
		TrialStartedAt      int64  `json:"trialStartedAt"`
		TrialEndsAt         int64  `json:"trialEndsAt"`
		InvoiceReference    string `json:"invoiceReference"`
		PaidPeriodStartedAt int64  `json:"paidPeriodStartedAt"`
		PaidPeriodEndsAt    int64  `json:"paidPeriodEndsAt"`
		CancelAt            int64  `json:"cancelAt"`
		CancelledAt         int64  `json:"cancelledAt"`
	} `json:"facts"`
	Snapshots []struct {
		SnapshotID             string `json:"snapshotId"`
		ObservedAt             int64  `json:"observedAt"`
		RecordedAt             int64  `json:"recordedAt"`
		PaymentMethodReady     bool   `json:"paymentMethodReady"`
		PaymentMethodUpdatedAt int64  `json:"paymentMethodUpdatedAt"`
		LatestPaidInvoice      *struct {
			InvoiceReference string `json:"invoiceReference"`
			PaidAt           int64  `json:"paidAt"`
			PeriodStartedAt  int64  `json:"periodStartedAt"`
			PeriodEndsAt     int64  `json:"periodEndsAt"`
		} `json:"latestPaidInvoice"`
		Delinquency *struct {
			Reason           string `json:"reason"`
			InvoiceReference string `json:"invoiceReference"`
			OccurredAt       int64  `json:"occurredAt"`
		} `json:"delinquency"`
		CancelAt              *int64 `json:"cancelAt"`
		CancellationUpdatedAt int64  `json:"cancellationUpdatedAt"`
		CancelledAt           *int64 `json:"cancelledAt"`
	} `json:"snapshots"`
	ProviderMapping struct {
		CustomerReference     string `json:"customerReference"`
		SubscriptionReference string `json:"subscriptionReference"`
	} `json:"providerMapping"`
	Expected struct {
		Version           int64  `json:"version"`
		Lifecycle         string `json:"lifecycle"`
		DelinquencyReason string `json:"delinquencyReason"`
		LastPaidAt        int64  `json:"lastPaidAt"`
		LastDelinquencyAt int64  `json:"lastDelinquencyAt"`
		LastReconciledAt  int64  `json:"lastReconciledAt"`
	} `json:"expected"`
}

func fixtureProviderFact(
	t *testing.T,
	fixture billingProjectionFixture,
	raw struct {
		Kind                string `json:"kind"`
		EventID             string `json:"eventId"`
		OccurredAt          int64  `json:"occurredAt"`
		RecordedAt          int64  `json:"recordedAt"`
		TrialStartedAt      int64  `json:"trialStartedAt"`
		TrialEndsAt         int64  `json:"trialEndsAt"`
		InvoiceReference    string `json:"invoiceReference"`
		PaidPeriodStartedAt int64  `json:"paidPeriodStartedAt"`
		PaidPeriodEndsAt    int64  `json:"paidPeriodEndsAt"`
		CancelAt            int64  `json:"cancelAt"`
		CancelledAt         int64  `json:"cancelledAt"`
	},
	subscriptionID SubscriptionID,
	provider Provider,
) VerifiedProviderFact {
	t.Helper()
	eventID, eventErr := ParseProviderEventID(raw.EventID)
	customer, customerErr := ParseProviderCustomerReference(fixture.ProviderMapping.CustomerReference)
	providerSubscription, subscriptionErr := ParseProviderSubscriptionReference(fixture.ProviderMapping.SubscriptionReference)
	if eventErr != nil || customerErr != nil || subscriptionErr != nil {
		t.Fatal(eventErr, customerErr, subscriptionErr)
	}
	fact := VerifiedProviderFact{
		Kind: FactKind(raw.Kind), SubscriptionID: subscriptionID, Provider: provider, EventID: eventID,
		ProviderCustomerReference: customer, ProviderSubscriptionReference: providerSubscription,
		OccurredAt: raw.OccurredAt, RecordedAt: raw.RecordedAt,
		TrialStartedAt: raw.TrialStartedAt, TrialEndsAt: raw.TrialEndsAt,
		PaidPeriodStartedAt: raw.PaidPeriodStartedAt, PaidPeriodEndsAt: raw.PaidPeriodEndsAt,
		CancelAt: raw.CancelAt, CancelledAt: raw.CancelledAt,
	}
	if raw.InvoiceReference != "" {
		fact.InvoiceReference, _ = ParseProviderInvoiceReference(raw.InvoiceReference)
	}
	return fact
}

func fixtureSnapshot(
	t *testing.T,
	fixture billingProjectionFixture,
	raw struct {
		SnapshotID             string `json:"snapshotId"`
		ObservedAt             int64  `json:"observedAt"`
		RecordedAt             int64  `json:"recordedAt"`
		PaymentMethodReady     bool   `json:"paymentMethodReady"`
		PaymentMethodUpdatedAt int64  `json:"paymentMethodUpdatedAt"`
		LatestPaidInvoice      *struct {
			InvoiceReference string `json:"invoiceReference"`
			PaidAt           int64  `json:"paidAt"`
			PeriodStartedAt  int64  `json:"periodStartedAt"`
			PeriodEndsAt     int64  `json:"periodEndsAt"`
		} `json:"latestPaidInvoice"`
		Delinquency *struct {
			Reason           string `json:"reason"`
			InvoiceReference string `json:"invoiceReference"`
			OccurredAt       int64  `json:"occurredAt"`
		} `json:"delinquency"`
		CancelAt              *int64 `json:"cancelAt"`
		CancellationUpdatedAt int64  `json:"cancellationUpdatedAt"`
		CancelledAt           *int64 `json:"cancelledAt"`
	},
	subscriptionID SubscriptionID,
	provider Provider,
) ReconciliationSnapshot {
	t.Helper()
	snapshotID, snapshotErr := ParseReconciliationSnapshotID(raw.SnapshotID)
	customer, customerErr := ParseProviderCustomerReference(fixture.ProviderMapping.CustomerReference)
	providerSubscription, subscriptionErr := ParseProviderSubscriptionReference(fixture.ProviderMapping.SubscriptionReference)
	if snapshotErr != nil || customerErr != nil || subscriptionErr != nil {
		t.Fatal(snapshotErr, customerErr, subscriptionErr)
	}
	snapshot := ReconciliationSnapshot{
		SnapshotID: snapshotID, SubscriptionID: subscriptionID, Provider: provider,
		ProviderCustomerReference: customer, ProviderSubscriptionReference: providerSubscription,
		ObservedAt: raw.ObservedAt, RecordedAt: raw.RecordedAt, PaymentMethodReady: raw.PaymentMethodReady,
		PaymentMethodUpdatedAt: raw.PaymentMethodUpdatedAt, CancelAt: raw.CancelAt,
		CancellationUpdatedAt: raw.CancellationUpdatedAt, CancelledAt: raw.CancelledAt,
	}
	if raw.LatestPaidInvoice != nil {
		reference, _ := ParseProviderInvoiceReference(raw.LatestPaidInvoice.InvoiceReference)
		snapshot.LatestPaidInvoice = &ReconciliationPaidInvoice{
			InvoiceReference: reference, PaidAt: raw.LatestPaidInvoice.PaidAt,
			PeriodStartedAt: raw.LatestPaidInvoice.PeriodStartedAt, PeriodEndsAt: raw.LatestPaidInvoice.PeriodEndsAt,
		}
	}
	if raw.Delinquency != nil {
		reference, _ := ParseProviderInvoiceReference(raw.Delinquency.InvoiceReference)
		snapshot.Delinquency = &ReconciliationDelinquency{
			Reason: DelinquencyReason(raw.Delinquency.Reason), InvoiceReference: reference, OccurredAt: raw.Delinquency.OccurredAt,
		}
	}
	return snapshot
}
