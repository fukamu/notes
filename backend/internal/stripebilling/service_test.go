package stripebilling

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestServiceRunsCheckoutAndKeepsRetryIdempotency(t *testing.T) {
	billingFake := &fakeBillingPort{beginResult: billing.CommandResult{Kind: billing.ResultApplied}, openedResult: billing.CommandResult{Kind: billing.ResultApplied}}
	provider := &fakeProviderPort{checkout: testCheckoutResponse(), loseFirstCheckoutResponse: true, snapshot: testProviderSnapshot()}
	service := newTestService(t, billingFake, provider, fakeVerifier{accepted: true})
	contextValue := testVaultContext(t)
	first := service.BeginHostedCheckout(context.Background(), contextValue, testCheckoutCommand())
	if first.Kind != HostedCheckoutRejected || first.Reason != ReasonProviderUnavailable {
		t.Fatalf("first = %#v", first)
	}
	billingFake.beginResult.Kind = billing.ResultReplayed
	second := service.BeginHostedCheckout(context.Background(), contextValue, testCheckoutCommand())
	if second.Kind != HostedCheckoutRedirect || second.ProviderCheckoutReference != "cs_test_FukamuA" {
		t.Fatalf("second = %#v", second)
	}
	if len(provider.checkoutCommands) != 2 || provider.checkoutCommands[0].IdempotencyKey != provider.checkoutCommands[1].IdempotencyKey {
		t.Fatalf("checkout commands = %#v", provider.checkoutCommands)
	}
}

func TestServiceVerifiesWebhookBeforeBillingAndMapsOutcomes(t *testing.T) {
	body := eventBody(t, "evt_paid_A", "invoice.paid", invoiceObject(true, "paid"), 5, false, APIVersion)
	billingFake := &fakeBillingPort{factResult: billing.CommandResult{Kind: billing.ResultDuplicate}}
	provider := &fakeProviderPort{checkout: testCheckoutResponse(), snapshot: testProviderSnapshot()}
	invalid := newTestService(t, billingFake, provider, fakeVerifier{})
	result := invalid.IngestWebhook(context.Background(), WebhookRequest{RawBody: body, SignatureHeader: "invalid", ReceivedAt: 5_100})
	if result.Kind != WebhookRejected || result.Reason != ReasonInvalidSignature || billingFake.factCalls != 0 {
		t.Fatalf("invalid result = %#v, calls = %d", result, billingFake.factCalls)
	}
	valid := newTestService(t, billingFake, provider, fakeVerifier{accepted: true})
	result = valid.IngestWebhook(context.Background(), WebhookRequest{RawBody: body, SignatureHeader: "accepted", ReceivedAt: 5_100})
	if result.Kind != WebhookAccepted || result.Outcome != billing.ResultDuplicate || billingFake.factCalls != 1 {
		t.Fatalf("valid result = %#v, calls = %d", result, billingFake.factCalls)
	}
	unsupported := eventBody(t, "evt_unknown_A", "customer.created", map[string]any{"id": "cus_FukamuA"}, 5, false, APIVersion)
	result = valid.IngestWebhook(context.Background(), WebhookRequest{RawBody: unsupported, SignatureHeader: "accepted", ReceivedAt: 5_100})
	if result.Kind != WebhookIgnored {
		t.Fatalf("unsupported = %#v", result)
	}
}

func TestServiceRetrievesSnapshotForCheckoutWebhookAndReconciliation(t *testing.T) {
	billingFake := &fakeBillingPort{snapshotResult: billing.CommandResult{Kind: billing.ResultApplied}}
	provider := &fakeProviderPort{checkout: testCheckoutResponse(), snapshot: testProviderSnapshot()}
	service := newTestService(t, billingFake, provider, fakeVerifier{accepted: true})
	checkout := eventBody(t, "evt_checkout_A", "checkout.session.completed", checkoutObject(), 2, false, APIVersion)
	result := service.IngestWebhook(context.Background(), WebhookRequest{RawBody: checkout, SignatureHeader: "accepted", ReceivedAt: 3_000})
	if result.Kind != WebhookAccepted || billingFake.snapshotCalls != 1 || provider.retrieveCalls != 1 {
		t.Fatalf("webhook result = %#v, billing calls = %d, provider calls = %d", result, billingFake.snapshotCalls, provider.retrieveCalls)
	}
	billingFake.snapshotResult.Kind = billing.ResultIgnored
	result = service.ReconcileSubscription(context.Background(), ReconciliationCommand{
		SnapshotID: "stripe_snapshot_B", SubscriptionID: testSubscriptionID,
		ProviderSubscriptionReference: "sub_FukamuA", ObservedAt: 4_000, RecordedAt: 4_100,
	})
	if result.Kind != WebhookAccepted || result.Outcome != billing.ResultIgnored || billingFake.snapshotCalls != 2 {
		t.Fatalf("reconcile result = %#v, calls = %d", result, billingFake.snapshotCalls)
	}
}

type fakeBillingPort struct {
	beginResult    billing.CommandResult
	openedResult   billing.CommandResult
	factResult     billing.CommandResult
	snapshotResult billing.CommandResult
	err            error
	factCalls      int
	snapshotCalls  int
}

func (fake *fakeBillingPort) BeginCheckout(context.Context, identity.VaultContext, billing.BeginCheckoutCommand) (billing.CommandResult, error) {
	return fake.beginResult, fake.err
}

func (fake *fakeBillingPort) RecordCheckoutOpened(context.Context, identity.VaultContext, billing.RecordCheckoutOpenedCommand) (billing.CommandResult, error) {
	return fake.openedResult, fake.err
}

func (fake *fakeBillingPort) IngestVerifiedProviderFact(_ context.Context, _ billing.VerifiedProviderFact) (billing.CommandResult, error) {
	fake.factCalls++
	return fake.factResult, fake.err
}

func (fake *fakeBillingPort) ReconcileVerifiedSnapshot(_ context.Context, _ billing.ReconciliationSnapshot) (billing.CommandResult, error) {
	fake.snapshotCalls++
	return fake.snapshotResult, fake.err
}

type fakeProviderPort struct {
	checkout                  CheckoutProviderResponse
	snapshot                  ProviderSubscriptionSnapshot
	err                       error
	loseFirstCheckoutResponse bool
	lost                      bool
	checkoutCommands          []CheckoutCreateCommand
	retrieveCalls             int
}

func (fake *fakeProviderPort) CreateCheckoutSession(_ context.Context, command CheckoutCreateCommand) (CheckoutProviderResponse, error) {
	fake.checkoutCommands = append(fake.checkoutCommands, command)
	if fake.loseFirstCheckoutResponse && !fake.lost {
		fake.lost = true
		return CheckoutProviderResponse{}, errors.New("lost response")
	}
	return fake.checkout, fake.err
}

func (fake *fakeProviderPort) RetrieveSubscriptionSnapshot(context.Context, billing.ProviderSubscriptionReference) (ProviderSubscriptionSnapshot, error) {
	fake.retrieveCalls++
	return fake.snapshot, fake.err
}

type fakeVerifier struct {
	accepted bool
}

func (verifier fakeVerifier) Verify(request WebhookRequest) VerificationResult {
	if !verifier.accepted {
		return VerificationResult{}
	}
	return VerificationResult{Verified: true, RawBody: append([]byte(nil), request.RawBody...)}
}

func newTestService(t *testing.T, billingPort BillingPort, provider ProviderPort, verifier WebhookVerifierPort) *Service {
	t.Helper()
	service, err := NewService(testConfiguration(), billingPort, provider, verifier)
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func testVaultContext(t *testing.T) identity.VaultContext {
	t.Helper()
	accountID, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000009010")
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-000000009011")
	if err != nil {
		t.Fatal(err)
	}
	return identity.VaultContext{AccountID: accountID, VaultID: vaultID}
}
