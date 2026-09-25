package stripeadapter

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/stripebilling"
	stripe "github.com/stripe/stripe-go/v84"
)

func TestProviderUsesPinnedSDKCheckoutContract(t *testing.T) {
	var captured url.Values
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost || request.URL.Path != "/v1/checkout/sessions" {
			http.NotFound(response, request)
			return
		}
		assertStripeHeaders(t, request, "01991f20-61d2-7000-8000-000000009002")
		if err := request.ParseForm(); err != nil {
			t.Fatal(err)
		}
		captured = request.PostForm
		writeJSON(t, response, checkoutResponseJSON())
	}))
	defer server.Close()
	provider := testProvider(t, server)
	command := testCreateCommand()
	result, err := provider.CreateCheckoutSession(context.Background(), command)
	if err != nil {
		t.Fatal(err)
	}
	if result.ID != "cs_test_FukamuA" || result.URL != "https://checkout.stripe.com/c/pay/cs_test_FukamuA" || result.Metadata["contract_offer_hash"] != command.Contract.OfferHash {
		t.Fatalf("result = %#v", result)
	}
	if len(captured) != len(command.FormFields()) {
		t.Fatalf("encoded fields = %#v", captured)
	}
	for _, field := range command.FormFields() {
		assertForm(t, captured, field.Name, field.Value)
	}
}

func TestProviderNormalizesExpandedSubscriptionSnapshot(t *testing.T) {
	var expansionQuery string
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodGet || request.URL.Path != "/v1/subscriptions/sub_FukamuA" {
			http.NotFound(response, request)
			return
		}
		assertStripeHeaders(t, request, "")
		expansionQuery = request.URL.RawQuery
		writeJSON(t, response, subscriptionResponseJSON())
	}))
	defer server.Close()
	provider := testProvider(t, server)
	snapshot, err := provider.RetrieveSubscriptionSnapshot(context.Background(), billing.ProviderSubscriptionReference("sub_FukamuA"))
	if err != nil {
		t.Fatal(err)
	}
	if snapshot.Subscription.ID != "sub_FukamuA" || snapshot.Subscription.Customer != "cus_FukamuA" ||
		snapshot.SetupIntent == nil || snapshot.SetupIntent.Status != "succeeded" ||
		snapshot.LatestInvoice == nil || snapshot.LatestInvoice.Status != "paid" ||
		snapshot.LatestPaymentIntent == nil || snapshot.LatestPaymentIntent.Status != "succeeded" || snapshot.LatestPaymentIntent.Invoice != "in_Fukamu1" {
		t.Fatalf("snapshot = %#v", snapshot)
	}
	joined, err := url.QueryUnescape(expansionQuery)
	if err != nil {
		t.Fatal(err)
	}
	for _, required := range []string{"pending_setup_intent", "latest_invoice", "latest_invoice.payments"} {
		if !strings.Contains(joined, required) {
			t.Fatalf("missing expansion %q in %q", required, joined)
		}
	}
}

func TestProviderRetrievesUnexpandedPaymentIntentAndPropagatesFailures(t *testing.T) {
	var mutex sync.Mutex
	paths := make([]string, 0, 2)
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		paths = append(paths, request.URL.Path)
		mutex.Unlock()
		switch request.URL.Path {
		case "/v1/subscriptions/sub_FukamuA":
			value := subscriptionResponseJSON()
			invoice := value["latest_invoice"].(map[string]any)
			payments := invoice["payments"].(map[string]any)
			data := payments["data"].([]any)
			payment := data[0].(map[string]any)["payment"].(map[string]any)
			payment["payment_intent"] = "pi_FukamuA"
			writeJSON(t, response, value)
		case "/v1/payment_intents/pi_FukamuA":
			writeJSON(t, response, map[string]any{
				"id": "pi_FukamuA", "object": "payment_intent", "status": "requires_action", "customer": "cus_FukamuA", "created": int64(2),
			})
		default:
			http.NotFound(response, request)
		}
	}))
	defer server.Close()
	provider := testProvider(t, server)
	snapshot, err := provider.RetrieveSubscriptionSnapshot(context.Background(), "sub_FukamuA")
	if err != nil || snapshot.LatestPaymentIntent == nil || snapshot.LatestPaymentIntent.Status != "requires_action" {
		t.Fatalf("snapshot = %#v, err = %v", snapshot, err)
	}
	mutex.Lock()
	defer mutex.Unlock()
	if len(paths) != 2 || paths[1] != "/v1/payment_intents/pi_FukamuA" {
		t.Fatalf("paths = %#v", paths)
	}
}

func TestProviderConfigurationRejectsModeMismatchAndProviderErrors(t *testing.T) {
	backends := testBackends(t, "http://127.0.0.1:1", http.DefaultClient)
	if _, err := newProviderWithBackends("sk_live_FukamuOnlyForStub", stripebilling.ModeTest, backends); err == nil {
		t.Fatal("live key accepted in test mode")
	}
	if _, err := newProviderWithBackends("sk_test_FukamuOnlyForStub", stripebilling.RuntimeMode("unknown"), backends); err == nil {
		t.Fatal("unknown runtime mode accepted")
	}
	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, _ *http.Request) {
		response.WriteHeader(http.StatusServiceUnavailable)
		writeJSON(t, response, map[string]any{"error": map[string]string{"message": "unavailable", "type": "api_error"}})
	}))
	defer server.Close()
	provider := testProvider(t, server)
	if _, err := provider.CreateCheckoutSession(context.Background(), testCreateCommand()); err == nil {
		t.Fatal("provider failure accepted")
	}
}

func TestCreateCheckoutSessionRejectsUnpinnedCommand(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	provider := testProvider(t, server)
	command := testCreateCommand()
	command.APIVersion = "latest"
	if _, err := provider.CreateCheckoutSession(context.Background(), command); !errors.Is(err, ErrInvalidProviderCommand) {
		t.Fatalf("error = %v", err)
	}
}

func TestRetrieveSubscriptionSnapshotRejectsInvalidReference(t *testing.T) {
	server := httptest.NewServer(http.NotFoundHandler())
	defer server.Close()
	provider := testProvider(t, server)
	if _, err := provider.RetrieveSubscriptionSnapshot(context.Background(), "../customers/cus_FukamuA"); !errors.Is(err, ErrInvalidProviderCommand) {
		t.Fatalf("error = %v", err)
	}
}

func testProvider(t *testing.T, server *httptest.Server) *Provider {
	t.Helper()
	provider, err := newProviderWithBackends("sk_test_FukamuOnlyForStub", stripebilling.ModeTest, testBackends(t, server.URL, server.Client()))
	if err != nil {
		t.Fatal(err)
	}
	return provider
}

func testBackends(t *testing.T, serverURL string, client *http.Client) *stripe.Backends {
	t.Helper()
	backend := stripe.GetBackendWithConfig(stripe.APIBackend, &stripe.BackendConfig{
		URL: stripe.String(serverURL), HTTPClient: client, MaxNetworkRetries: stripe.Int64(0), EnableTelemetry: stripe.Bool(false),
		LeveledLogger: &stripe.LeveledLogger{Level: stripe.LevelNull},
	})
	return &stripe.Backends{API: backend, Connect: backend, Uploads: backend, MeterEvents: backend}
}

func testCreateCommand() stripebilling.CheckoutCreateCommand {
	return stripebilling.CheckoutCreateCommand{
		APIVersion: stripebilling.APIVersion, IdempotencyKey: "01991f20-61d2-7000-8000-000000009002",
		PriceReference: "price_FukamuMonthly", SuccessURL: "https://notes.example.test/billing/success?session_id={CHECKOUT_SESSION_ID}",
		CancelURL: "https://notes.example.test/billing/cancel", SubscriptionID: "01991f20-61d2-7000-8000-000000009001",
		CheckoutIntentID: "01991f20-61d2-7000-8000-000000009002",
		Contract: stripebilling.HostedCheckoutContract{
			EvidenceID: "01991f20-61d2-7000-8000-000000009003",
			OfferHash:  "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
			Offer:      stripebilling.ContractOffer{OfferVersion: "legal-commerce-v1:2026-09-01", DisclosureVersion: "2026-09-01", BillingPeriod: stripebilling.BillingMonthly, RenewalChargeYen: 1_280},
		},
		SubmitMessage: "14日間は0円です。15日目から税込1280円を毎月自動課金します。",
	}
}

func checkoutResponseJSON() map[string]any {
	command := testCreateCommand()
	return map[string]any{
		"id": "cs_test_FukamuA", "object": "checkout.session", "mode": "subscription", "livemode": false,
		"client_reference_id": string(command.CheckoutIntentID), "url": "https://checkout.stripe.com/c/pay/cs_test_FukamuA",
		"metadata": map[string]string{
			"billing_subscription_id": string(command.SubscriptionID), "checkout_intent_id": string(command.CheckoutIntentID),
			"contract_evidence_id": command.Contract.EvidenceID, "contract_offer_hash": command.Contract.OfferHash,
			"contract_offer_version": command.Contract.Offer.OfferVersion, "contract_disclosure_version": command.Contract.Offer.DisclosureVersion,
		},
	}
}

func subscriptionResponseJSON() map[string]any {
	return map[string]any{
		"id": "sub_FukamuA", "object": "subscription", "customer": map[string]any{"id": "cus_FukamuA", "object": "customer"},
		"status": "trialing", "created": int64(2), "metadata": map[string]string{"billing_subscription_id": "01991f20-61d2-7000-8000-000000009001"},
		"trial_start": int64(2), "trial_end": int64(1_209_602), "default_payment_method": map[string]any{"id": "pm_FukamuA", "object": "payment_method"},
		"cancel_at": nil, "canceled_at": nil, "ended_at": nil,
		"pending_setup_intent": map[string]any{
			"id": "seti_FukamuA", "object": "setup_intent", "status": "succeeded", "usage": "off_session", "created": int64(2),
			"customer": "cus_FukamuA", "payment_method": "pm_FukamuA",
		},
		"latest_invoice": map[string]any{
			"id": "in_Fukamu1", "object": "invoice", "customer": "cus_FukamuA", "status": "paid", "period_start": int64(10), "period_end": int64(2_592_010),
			"parent": map[string]any{"type": "subscription_details", "subscription_details": map[string]any{
				"subscription": "sub_FukamuA", "metadata": map[string]string{"billing_subscription_id": "01991f20-61d2-7000-8000-000000009001"},
			}},
			"payments": map[string]any{"object": "list", "data": []any{map[string]any{
				"id": "inpay_FukamuA", "object": "invoice_payment", "is_default": true,
				"payment": map[string]any{"type": "payment_intent", "payment_intent": map[string]any{
					"id": "pi_FukamuA", "object": "payment_intent", "status": "succeeded", "customer": "cus_FukamuA", "created": int64(2),
				}},
			}}},
		},
	}
}

func assertStripeHeaders(t *testing.T, request *http.Request, idempotencyKey string) {
	t.Helper()
	if request.Header.Get("Stripe-Version") != stripebilling.APIVersion || request.Header.Get("Authorization") != "Bearer sk_test_FukamuOnlyForStub" {
		t.Fatalf("headers = %#v", request.Header)
	}
	if request.Header.Get("Idempotency-Key") != idempotencyKey {
		t.Fatalf("idempotency = %q", request.Header.Get("Idempotency-Key"))
	}
}

func assertForm(t *testing.T, values url.Values, key string, expected string) {
	t.Helper()
	if values.Get(key) != expected {
		t.Fatalf("form %s = %q, expected %q", key, values.Get(key), expected)
	}
}

func writeJSON(t *testing.T, response http.ResponseWriter, value any) {
	t.Helper()
	response.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(response).Encode(value); err != nil {
		t.Fatal(err)
	}
}
