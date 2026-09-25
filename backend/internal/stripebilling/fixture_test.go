package stripebilling

import (
	"encoding/json"
	"maps"
	"os"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
)

func TestSharedStripeFixtureMatchesTypeScriptContract(t *testing.T) {
	fixtureBytes, err := os.ReadFile("../../../contracts/fixtures/billing/stripe.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct {
		Configuration struct {
			Mode           RuntimeMode `json:"mode"`
			APIVersion     string      `json:"apiVersion"`
			PriceReference string      `json:"priceReference"`
			SuccessURL     string      `json:"successUrl"`
			CancelURL      string      `json:"cancelUrl"`
		} `json:"configuration"`
		Command struct {
			SubscriptionID   string `json:"subscriptionId"`
			CheckoutIntentID string `json:"checkoutIntentId"`
			CreatedAt        int64  `json:"createdAt"`
			Contract         struct {
				EvidenceID string `json:"evidenceId"`
				OfferHash  string `json:"offerHash"`
				Offer      struct {
					OfferVersion      string        `json:"offerVersion"`
					DisclosureVersion string        `json:"disclosureVersion"`
					BillingPeriod     BillingPeriod `json:"billingPeriod"`
					RenewalChargeYen  int64         `json:"renewalChargeYen"`
				} `json:"offer"`
			} `json:"contract"`
		} `json:"command"`
		ExpectedCheckout struct {
			IdempotencyKey string            `json:"idempotencyKey"`
			Fields         map[string]string `json:"fields"`
		} `json:"expectedCheckout"`
		Webhook struct {
			Secret          string `json:"secret"`
			ReceivedAt      int64  `json:"receivedAt"`
			SignatureHeader string `json:"signatureHeader"`
			RawBody         string `json:"rawBody"`
			Expected        struct {
				Kind                          billing.FactKind `json:"kind"`
				EventID                       string           `json:"eventId"`
				SubscriptionID                string           `json:"subscriptionId"`
				ProviderCustomerReference     string           `json:"providerCustomerReference"`
				ProviderSubscriptionReference string           `json:"providerSubscriptionReference"`
				InvoiceReference              string           `json:"invoiceReference"`
				OccurredAt                    int64            `json:"occurredAt"`
				RecordedAt                    int64            `json:"recordedAt"`
				PaidPeriodStartedAt           int64            `json:"paidPeriodStartedAt"`
				PaidPeriodEndsAt              int64            `json:"paidPeriodEndsAt"`
			} `json:"expected"`
		} `json:"webhook"`
	}
	if err := json.Unmarshal(fixtureBytes, &fixture); err != nil {
		t.Fatal(err)
	}

	configuration := Configuration(fixture.Configuration)
	command := HostedCheckoutCommand{
		SubscriptionID:   billing.SubscriptionID(fixture.Command.SubscriptionID),
		CheckoutIntentID: billing.CheckoutIntentID(fixture.Command.CheckoutIntentID),
		CreatedAt:        fixture.Command.CreatedAt,
		Contract: HostedCheckoutContract{
			EvidenceID: fixture.Command.Contract.EvidenceID,
			OfferHash:  fixture.Command.Contract.OfferHash,
			Offer:      ContractOffer(fixture.Command.Contract.Offer),
		},
	}
	planned, err := PlanCheckout(configuration, command)
	if err != nil {
		t.Fatal(err)
	}
	if string(planned.IdempotencyKey) != fixture.ExpectedCheckout.IdempotencyKey {
		t.Fatalf("idempotency key = %q", planned.IdempotencyKey)
	}
	fields := make(map[string]string, len(planned.FormFields()))
	for _, field := range planned.FormFields() {
		if _, duplicate := fields[field.Name]; duplicate {
			t.Fatalf("duplicate Checkout field %q", field.Name)
		}
		fields[field.Name] = field.Value
	}
	if !maps.Equal(fields, fixture.ExpectedCheckout.Fields) {
		t.Fatalf("Checkout fields = %#v, expected %#v", fields, fixture.ExpectedCheckout.Fields)
	}

	verifier, err := NewHMACWebhookVerifier(fixture.Webhook.Secret, WebhookToleranceMillis)
	if err != nil {
		t.Fatal(err)
	}
	verification := verifier.Verify(WebhookRequest{
		RawBody: []byte(fixture.Webhook.RawBody), SignatureHeader: fixture.Webhook.SignatureHeader, ReceivedAt: fixture.Webhook.ReceivedAt,
	})
	if !verification.Verified || string(verification.RawBody) != fixture.Webhook.RawBody {
		t.Fatalf("verification = %#v", verification)
	}
	plan := DecodeEventPlan(verification.RawBody, configuration.Mode, configuration.APIVersion, fixture.Webhook.ReceivedAt)
	if plan.Kind != EventFact || plan.Fact == nil {
		t.Fatalf("event plan = %#v", plan)
	}
	fact := plan.Fact
	expected := fixture.Webhook.Expected
	if fact.Kind != expected.Kind || string(fact.EventID) != expected.EventID || string(fact.SubscriptionID) != expected.SubscriptionID ||
		string(fact.ProviderCustomerReference) != expected.ProviderCustomerReference || string(fact.ProviderSubscriptionReference) != expected.ProviderSubscriptionReference ||
		string(fact.InvoiceReference) != expected.InvoiceReference || fact.OccurredAt != expected.OccurredAt || fact.RecordedAt != expected.RecordedAt ||
		fact.PaidPeriodStartedAt != expected.PaidPeriodStartedAt || fact.PaidPeriodEndsAt != expected.PaidPeriodEndsAt {
		t.Fatalf("fact = %#v, expected = %#v", fact, expected)
	}
}
