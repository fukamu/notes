package stripebilling

import (
	"encoding/json"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
)

const (
	testSubscriptionID = "01991f20-61d2-7000-8000-000000009001"
	testCheckoutID     = "01991f20-61d2-7000-8000-000000009002"
	testEvidenceID     = "01991f20-61d2-7000-8000-000000009003"
)

func TestPlanCheckoutMatchesPinnedContract(t *testing.T) {
	planned, err := PlanCheckout(testConfiguration(), testCheckoutCommand())
	if err != nil {
		t.Fatal(err)
	}
	if planned.APIVersion != APIVersion || planned.IdempotencyKey != billing.CheckoutIntentID(testCheckoutID) {
		t.Fatalf("planned identifiers = %#v", planned)
	}
	fields := make(map[string]string)
	for _, field := range planned.FormFields() {
		if _, exists := fields[field.Name]; exists {
			t.Fatalf("duplicate field %q", field.Name)
		}
		fields[field.Name] = field.Value
	}
	assertField(t, fields, "mode", "subscription")
	assertField(t, fields, "payment_method_collection", "always")
	assertField(t, fields, "payment_method_options[card][request_three_d_secure]", "any")
	assertField(t, fields, "subscription_data[trial_period_days]", "14")
	assertField(t, fields, "subscription_data[trial_settings][end_behavior][missing_payment_method]", "cancel")
	assertField(t, fields, "metadata[contract_evidence_id]", testEvidenceID)
	if len(fields["custom_text[submit][message]"]) > 1_200 {
		t.Fatal("submit message exceeds Stripe limit")
	}
	if _, err := PlanCheckout(Configuration{Mode: ModeTest, APIVersion: "latest"}, testCheckoutCommand()); err == nil {
		t.Fatal("unpinned API version accepted")
	}
	configuration := testConfiguration()
	configuration.SuccessURL = "http://notes.example.test/success"
	if _, err := PlanCheckout(configuration, testCheckoutCommand()); err == nil {
		t.Fatal("insecure remote callback accepted")
	}
}

func TestDecodeCheckoutResponseChecksMappingAndRedirect(t *testing.T) {
	command := testCheckoutCommand()
	input := testCheckoutResponse()
	decoded, reason := DecodeCheckoutResponse(input, command, ModeTest)
	if reason != "" || decoded.ProviderCheckoutReference != "cs_test_FukamuA" || decoded.CheckoutURL != input.URL {
		t.Fatalf("decoded = %#v, reason = %q", decoded, reason)
	}
	input.Metadata["billing_subscription_id"] = "01991f20-61d2-7000-8000-000000009099"
	if _, reason := DecodeCheckoutResponse(input, command, ModeTest); reason != ReasonProviderMappingMismatch {
		t.Fatalf("mapping mismatch reason = %q", reason)
	}
	input = testCheckoutResponse()
	input.URL = "https://example.test/not-stripe"
	if _, reason := DecodeCheckoutResponse(input, command, ModeTest); reason != ReasonMalformedProviderResponse {
		t.Fatalf("redirect reason = %q", reason)
	}
}

func TestDecodeEventPlanMapsSupportedEvents(t *testing.T) {
	checkout := DecodeEventPlan(eventBody(t, "evt_checkout_A", "checkout.session.completed", checkoutObject(), 2, false, APIVersion), ModeTest, APIVersion, 3_000)
	if checkout.Kind != EventSnapshot || checkout.Snapshot == nil || checkout.Snapshot.SubscriptionID != testSubscriptionID || checkout.Snapshot.ObservedAt != 2_000 {
		t.Fatalf("checkout plan = %#v", checkout)
	}
	paid := DecodeEventPlan(eventBody(t, "evt_paid_A", "invoice.paid", invoiceObject(true, "paid"), 5, false, APIVersion), ModeTest, APIVersion, 5_100)
	if paid.Kind != EventFact || paid.Fact == nil || paid.Fact.Kind != billing.FactInvoicePaid || paid.Fact.PaidPeriodEndsAt != 2_592_010_000 {
		t.Fatalf("paid plan = %#v", paid)
	}
	action := DecodeEventPlan(eventBody(t, "evt_action_A", "invoice.payment_action_required", invoiceObject(false, "open"), 6, false, APIVersion), ModeTest, APIVersion, 6_100)
	if action.Kind != EventFact || action.Fact == nil || action.Fact.Kind != billing.FactInvoicePaymentActionRequired {
		t.Fatalf("action plan = %#v", action)
	}
	setup := DecodeEventPlan(eventBody(t, "evt_setup_A", "setup_intent.succeeded", setupObject(), 7, false, APIVersion), ModeTest, APIVersion, 7_100)
	if setup.Kind != EventFact || setup.Fact == nil || setup.Fact.Kind != billing.FactPaymentMethodUpdated {
		t.Fatalf("setup plan = %#v", setup)
	}
	scheduled := DecodeEventPlan(eventBody(t, "evt_schedule_A", "customer.subscription.updated", subscriptionObject("trialing", int64Pointer(20), nil), 8, false, APIVersion), ModeTest, APIVersion, 8_100)
	if scheduled.Kind != EventFact || scheduled.Fact == nil || scheduled.Fact.Kind != billing.FactCancellationScheduled || scheduled.Fact.CancelAt != 20_000 {
		t.Fatalf("scheduled plan = %#v", scheduled)
	}
	deleted := DecodeEventPlan(eventBody(t, "evt_deleted_A", "customer.subscription.deleted", subscriptionObject("canceled", nil, int64Pointer(9)), 9, false, APIVersion), ModeTest, APIVersion, 9_100)
	if deleted.Kind != EventFact || deleted.Fact == nil || deleted.Fact.Kind != billing.FactSubscriptionCancelled || deleted.Fact.CancelledAt != 9_000 {
		t.Fatalf("deleted plan = %#v", deleted)
	}
}

func TestDecodeEventPlanFailsClosed(t *testing.T) {
	validInvoice := invoiceObject(true, "paid")
	cases := []struct {
		name   string
		body   []byte
		reason RejectionReason
	}{
		{name: "mode", body: eventBody(t, "evt_mode_A", "invoice.paid", validInvoice, 2, true, APIVersion), reason: ReasonRuntimeModeMismatch},
		{name: "version", body: eventBody(t, "evt_version_A", "invoice.paid", validInvoice, 2, false, "2025-12-15.clover"), reason: ReasonAPIVersionMismatch},
		{name: "future", body: eventBody(t, "evt_future_A", "invoice.paid", validInvoice, 4, false, APIVersion), reason: ReasonMalformedEvent},
		{name: "claim", body: eventBody(t, "evt_claim_A", "invoice.paid", invoiceObject(false, "open"), 2, false, APIVersion), reason: ReasonMalformedEvent},
		{name: "utf8", body: []byte{0xff}, reason: ReasonMalformedEvent},
	}
	for _, testCase := range cases {
		t.Run(testCase.name, func(t *testing.T) {
			plan := DecodeEventPlan(testCase.body, ModeTest, APIVersion, 3_000)
			if plan.Kind != EventRejected || plan.Reason != testCase.reason {
				t.Fatalf("plan = %#v", plan)
			}
		})
	}
}

func TestDecodeReconciliationSnapshotRequiresVerifiedMapping(t *testing.T) {
	plan := testSnapshotPlan(3_000)
	snapshot, ok := DecodeReconciliationSnapshot(testProviderSnapshot(), plan)
	if !ok || !snapshot.PaymentMethodReady || snapshot.Trial == nil || snapshot.Trial.StartedAt != 2_000 || snapshot.Trial.EndsAt != 1_209_602_000 {
		t.Fatalf("snapshot = %#v, ok = %v", snapshot, ok)
	}
	input := testProviderSnapshot()
	input.SetupIntent.Status = "requires_action"
	if _, ok := DecodeReconciliationSnapshot(input, plan); ok {
		t.Fatal("trial without succeeded setup intent accepted")
	}
	input = testProviderSnapshot()
	input.Subscription.Metadata["billing_subscription_id"] = "01991f20-61d2-7000-8000-000000009099"
	if _, ok := DecodeReconciliationSnapshot(input, plan); ok {
		t.Fatal("provider mapping mismatch accepted")
	}
	input = testProviderSnapshot()
	input.Subscription.Customer = "cus_OtherCustomer"
	if _, ok := DecodeReconciliationSnapshot(input, plan); ok {
		t.Fatal("provider customer mismatch accepted")
	}
}

func TestDecodeReconciliationSnapshotMapsPaidAndDelinquentStates(t *testing.T) {
	paidInput := testProviderSnapshot()
	paidInput.LatestInvoice.Status = "paid"
	paidAt := int64(6)
	paidInput.LatestInvoice.PaidAtSeconds = &paidAt
	paid, ok := DecodeReconciliationSnapshot(paidInput, testSnapshotPlan(8_000))
	if !ok || paid.LatestPaidInvoice == nil || paid.LatestPaidInvoice.InvoiceReference != "in_Fukamu1" ||
		paid.LatestPaidInvoice.PaidAt != 6_000 || paid.Delinquency != nil {
		t.Fatalf("paid snapshot = %#v, ok = %v", paid, ok)
	}
	delinquentInput := testProviderSnapshot()
	delinquentInput.LatestPaymentIntent = &ProviderPaymentIntent{
		ID: "pi_FukamuA", Object: "payment_intent", Status: "requires_action", Customer: "cus_FukamuA", Invoice: "in_Fukamu1", CreatedSeconds: 2,
	}
	delinquent, ok := DecodeReconciliationSnapshot(delinquentInput, testSnapshotPlan(9_000))
	if !ok || delinquent.Delinquency == nil || delinquent.Delinquency.Reason != billing.DelinquencyPaymentActionRequired ||
		delinquent.Delinquency.OccurredAt != 2_000 {
		t.Fatalf("delinquent snapshot = %#v, ok = %v", delinquent, ok)
	}
}

func TestDecodeReconciliationSnapshotRejectsUnstableOrFutureProviderEvidence(t *testing.T) {
	tests := []struct {
		name   string
		mutate func(*ProviderSubscriptionSnapshot)
	}{
		{
			name: "paid without transition time",
			mutate: func(value *ProviderSubscriptionSnapshot) {
				value.LatestInvoice.Status = "paid"
			},
		},
		{
			name: "future paid transition",
			mutate: func(value *ProviderSubscriptionSnapshot) {
				value.LatestInvoice.Status = "paid"
				paidAt := int64(9)
				value.LatestInvoice.PaidAtSeconds = &paidAt
			},
		},
		{
			name: "paid transition before invoice",
			mutate: func(value *ProviderSubscriptionSnapshot) {
				value.LatestInvoice.Status = "paid"
				paidAt := int64(1)
				value.LatestInvoice.PaidAtSeconds = &paidAt
			},
		},
		{
			name: "unpaid invoice with paid transition",
			mutate: func(value *ProviderSubscriptionSnapshot) {
				paidAt := int64(3)
				value.LatestInvoice.PaidAtSeconds = &paidAt
			},
		},
		{
			name: "future subscription",
			mutate: func(value *ProviderSubscriptionSnapshot) {
				value.Subscription.CreatedSeconds = 9
			},
		},
		{
			name: "future invoice",
			mutate: func(value *ProviderSubscriptionSnapshot) {
				value.LatestInvoice.CreatedSeconds = 9
			},
		},
		{
			name: "future payment intent",
			mutate: func(value *ProviderSubscriptionSnapshot) {
				value.LatestPaymentIntent = &ProviderPaymentIntent{
					ID: "pi_FukamuA", Object: "payment_intent", Status: "requires_action",
					Customer: "cus_FukamuA", Invoice: "in_Fukamu1", CreatedSeconds: 9,
				}
			},
		},
		{
			name: "payment intent before invoice",
			mutate: func(value *ProviderSubscriptionSnapshot) {
				value.LatestInvoice.CreatedSeconds = 3
				value.LatestPaymentIntent = &ProviderPaymentIntent{
					ID: "pi_FukamuA", Object: "payment_intent", Status: "requires_action",
					Customer: "cus_FukamuA", Invoice: "in_Fukamu1", CreatedSeconds: 2,
				}
			},
		},
		{
			name: "future setup intent",
			mutate: func(value *ProviderSubscriptionSnapshot) {
				value.SetupIntent.CreatedSeconds = 9
			},
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			input := testProviderSnapshot()
			testCase.mutate(&input)
			if snapshot, ok := DecodeReconciliationSnapshot(input, testSnapshotPlan(8_000)); ok {
				t.Fatalf("accepted snapshot = %#v", snapshot)
			}
		})
	}
}

func testConfiguration() Configuration {
	return Configuration{
		Mode: ModeTest, APIVersion: APIVersion, PriceReference: "price_FukamuMonthly",
		SuccessURL: "https://notes.example.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
		CancelURL:  "https://notes.example.test/billing/cancel",
	}
}

func testCheckoutCommand() HostedCheckoutCommand {
	return HostedCheckoutCommand{
		SubscriptionID: testSubscriptionID, CheckoutIntentID: testCheckoutID, CreatedAt: 1_000,
		Contract: HostedCheckoutContract{
			EvidenceID: testEvidenceID, OfferHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Offer: ContractOffer{OfferVersion: "legal-commerce-v1:2026-09-01", DisclosureVersion: "2026-09-01", BillingPeriod: BillingMonthly, RenewalChargeYen: 1_280},
		},
	}
}

func testCheckoutResponse() CheckoutProviderResponse {
	contract := testCheckoutCommand().Contract
	return CheckoutProviderResponse{
		ID: "cs_test_FukamuA", Object: "checkout.session", Mode: "subscription", LiveMode: false,
		ClientReferenceID: testCheckoutID, URL: "https://checkout.stripe.com/c/pay/cs_test_FukamuA",
		Metadata: map[string]string{
			"billing_subscription_id": testSubscriptionID, "checkout_intent_id": testCheckoutID,
			"contract_evidence_id": contract.EvidenceID, "contract_offer_hash": contract.OfferHash,
			"contract_offer_version": contract.Offer.OfferVersion, "contract_disclosure_version": contract.Offer.DisclosureVersion,
		},
	}
}

func eventBody(t *testing.T, id string, eventType string, object any, created int64, live bool, apiVersion string) []byte {
	t.Helper()
	body, err := json.Marshal(map[string]any{
		"id": id, "object": "event", "api_version": apiVersion, "created": created,
		"livemode": live, "type": eventType, "data": map[string]any{"object": object},
	})
	if err != nil {
		t.Fatal(err)
	}
	return body
}

func checkoutObject() map[string]any {
	response := testCheckoutResponse()
	return map[string]any{
		"id": response.ID, "object": response.Object, "mode": response.Mode, "status": "complete", "livemode": response.LiveMode,
		"customer": "cus_FukamuA", "subscription": "sub_FukamuA", "client_reference_id": response.ClientReferenceID, "metadata": response.Metadata,
	}
}

func invoiceObject(paid bool, status string) map[string]any {
	return map[string]any{
		"id": "in_Fukamu1", "object": "invoice", "customer": "cus_FukamuA", "paid": paid, "status": status,
		"period_start": int64(10), "period_end": int64(2_592_010),
		"parent": map[string]any{"type": "subscription_details", "subscription_details": map[string]any{
			"subscription": "sub_FukamuA", "metadata": map[string]string{"billing_subscription_id": testSubscriptionID},
		}},
	}
}

func setupObject() map[string]any {
	return map[string]any{
		"id": "seti_FukamuA", "object": "setup_intent", "status": "succeeded", "usage": "off_session",
		"customer": "cus_FukamuA", "payment_method": "pm_FukamuA",
		"metadata": map[string]string{"billing_subscription_id": testSubscriptionID, "provider_subscription_id": "sub_FukamuA"},
	}
}

func subscriptionObject(status string, cancelAt *int64, endedAt *int64) map[string]any {
	return map[string]any{
		"id": "sub_FukamuA", "object": "subscription", "customer": "cus_FukamuA", "status": status,
		"metadata": map[string]string{"billing_subscription_id": testSubscriptionID}, "cancel_at": cancelAt, "ended_at": endedAt,
	}
}

func testSnapshotPlan(observedAt int64) SnapshotPlan {
	return SnapshotPlan{
		SnapshotID: "stripe_snapshot_A", SubscriptionID: testSubscriptionID,
		ProviderCustomerReference:     "cus_FukamuA",
		ProviderSubscriptionReference: "sub_FukamuA", ObservedAt: observedAt, RecordedAt: observedAt + 100,
	}
}

func testProviderSnapshot() ProviderSubscriptionSnapshot {
	trialStart := int64(2)
	trialEnd := int64(1_209_602)
	paymentMethod := "pm_FukamuA"
	return ProviderSubscriptionSnapshot{
		Subscription: ProviderSubscription{
			ID: "sub_FukamuA", Object: "subscription", Customer: "cus_FukamuA", Status: "trialing", CreatedSeconds: 2,
			Metadata: map[string]string{"billing_subscription_id": testSubscriptionID}, TrialStartSeconds: &trialStart, TrialEndSeconds: &trialEnd,
			DefaultPaymentMethod: &paymentMethod,
		},
		SetupIntent: &ProviderSetupIntent{
			ID: "seti_FukamuA", Object: "setup_intent", Status: "succeeded", Usage: "off_session",
			Customer: "cus_FukamuA", PaymentMethod: &paymentMethod, CreatedSeconds: 2,
		},
		LatestInvoice: &ProviderInvoice{
			ID: "in_Fukamu1", Object: "invoice", Customer: "cus_FukamuA", Status: "open",
			CreatedSeconds: 2, PeriodStartSeconds: 10, PeriodEndSeconds: 2_592_010,
			SubscriptionReference: "sub_FukamuA", SubscriptionID: testSubscriptionID,
		},
	}
}

func assertField(t *testing.T, values map[string]string, name string, expected string) {
	t.Helper()
	if values[name] != expected {
		t.Fatalf("field %s = %q, expected %q", name, values[name], expected)
	}
}

func int64Pointer(value int64) *int64 {
	return &value
}
