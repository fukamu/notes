package localcommerce

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	fixture "github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/fukamu/notes/backend/internal/stripebilling"
)

func TestNoNetworkProviderConfirmsOnlyExactSeededFacts(t *testing.T) {
	t.Parallel()
	seed := providerSeed(t)
	subscriptions := &subscriptionStub{record: seed.Subscription}
	entitlements := &entitlementStub{record: seed.Entitlement}
	provider, err := NewProvider(seed, subscriptions, entitlements)
	if err != nil {
		t.Fatal(err)
	}
	command := providerCheckoutCommand()
	result := provider.BeginHostedCheckout(context.Background(), seed.Context, command)
	if result.Kind != stripebilling.HostedCheckoutLocalConfirmed || result.CheckoutURL != "" ||
		result.ProviderCheckoutReference != "" || subscriptions.reads != 1 || entitlements.reads != 1 {
		t.Fatalf("checkout = %#v reads=%d/%d", result, subscriptions.reads, entitlements.reads)
	}

	wrongContext := seed.Context
	wrongContext.VaultID = "01999c20-9e33-7000-8000-000000000099"
	result = provider.BeginHostedCheckout(context.Background(), wrongContext, command)
	if result.Kind != stripebilling.HostedCheckoutRejected ||
		result.Reason != stripebilling.ReasonProviderMappingMismatch || subscriptions.reads != 1 {
		t.Fatalf("cross owner checkout = %#v reads=%d", result, subscriptions.reads)
	}

	subscriptions.record.ProviderSubscriptionReference = "fixture-subscription-mismatch"
	result = provider.BeginHostedCheckout(context.Background(), seed.Context, command)
	if result.Kind != stripebilling.HostedCheckoutRejected || result.Reason != stripebilling.ReasonProviderMappingMismatch {
		t.Fatalf("mismatched projection checkout = %#v", result)
	}
}

func TestNoNetworkProviderSchedulesStablePeriodEndCancellation(t *testing.T) {
	t.Parallel()
	seed := providerSeed(t)
	provider, err := NewProvider(
		seed,
		&subscriptionStub{record: seed.Subscription},
		&entitlementStub{record: seed.Entitlement},
	)
	if err != nil {
		t.Fatal(err)
	}
	key, _ := billing.ParseCancellationIdempotencyKey("cancel_fixture_stable")
	command := billing.ProviderCancellationCommand{
		Provider:                      seed.Subscription.Provider,
		ProviderSubscriptionReference: seed.Subscription.ProviderSubscriptionReference,
		IdempotencyKey:                key, RequestedAt: 1_000, Effect: billing.ProviderCancellationPeriodEnd,
	}
	first, err := provider.CancelSubscription(context.Background(), command)
	if err != nil || first.Kind != billing.ProviderCancellationScheduled ||
		first.ObservedAt != identity.MaximumSafeInteger || first.AccessEndsAt != identity.MaximumSafeInteger {
		t.Fatalf("first cancellation = %#v, %v", first, err)
	}
	command.RequestedAt = 2_000
	second, err := provider.CancelSubscription(context.Background(), command)
	if err != nil || second != first {
		t.Fatalf("stable cancellation = %#v, %v; want %#v", second, err, first)
	}

	command.ProviderSubscriptionReference = "fixture-subscription-other"
	rejected, err := provider.CancelSubscription(context.Background(), command)
	if err != nil || rejected.Kind != billing.ProviderCancellationTerminalFailure ||
		rejected.AccessEndsAt != 0 {
		t.Fatalf("mapping mismatch = %#v, %v", rejected, err)
	}
}

func TestNoNetworkProviderFailsClosedOnDependenciesAndConfiguration(t *testing.T) {
	t.Parallel()
	seed := providerSeed(t)
	if _, err := NewProvider(fixture.Seed{}, &subscriptionStub{}, &entitlementStub{}); !errors.Is(err, ErrInvalidProviderConfiguration) {
		t.Fatalf("invalid seed error = %v", err)
	}
	provider, err := NewProvider(
		seed,
		&subscriptionStub{record: seed.Subscription, err: errors.New("database detail")},
		&entitlementStub{record: seed.Entitlement},
	)
	if err != nil {
		t.Fatal(err)
	}
	result := provider.BeginHostedCheckout(context.Background(), seed.Context, providerCheckoutCommand())
	if result.Kind != stripebilling.HostedCheckoutRejected || result.Reason != stripebilling.ReasonProviderMappingMismatch {
		t.Fatalf("dependency failure = %#v", result)
	}
}

type subscriptionStub struct {
	record billing.SubscriptionRecord
	err    error
	reads  int
}

func (stub *subscriptionStub) FindByOwner(context.Context, billing.OwnerScope) (*billing.SubscriptionRecord, error) {
	stub.reads++
	if stub.err != nil {
		return nil, stub.err
	}
	copy := stub.record
	return &copy, nil
}

type entitlementStub struct {
	record entitlement.ProjectionRecord
	err    error
	reads  int
}

func (stub *entitlementStub) FindProjection(context.Context, identity.VaultContext) (*entitlement.ProjectionRecord, error) {
	stub.reads++
	if stub.err != nil {
		return nil, stub.err
	}
	copy := stub.record
	return &copy, nil
}

func providerCheckoutCommand() stripebilling.HostedCheckoutCommand {
	return stripebilling.HostedCheckoutCommand{
		SubscriptionID:   "01999c20-9e33-7000-8000-000000000701",
		CheckoutIntentID: "01999c20-9e33-7000-8000-000000000702",
		CreatedAt:        2_000,
		Contract: stripebilling.HostedCheckoutContract{
			EvidenceID: "01999c20-9e33-7000-8000-000000000701",
			OfferHash:  localOfferHash,
			Offer: stripebilling.ContractOffer{
				OfferVersion: "legal-commerce-v1:2026-09-15", DisclosureVersion: "2026-09-15",
				BillingPeriod: stripebilling.BillingMonthly, RenewalChargeYen: 980,
			},
		},
	}
}

func providerSeed(t *testing.T) fixture.Seed {
	t.Helper()
	allowed, _ := access.ParseSubject("fixture-owner")
	accountID, _ := identity.ParseAccountID("01999c20-9e33-7000-8000-000000000001")
	vaultID, _ := identity.ParseVaultID("01999c20-9e33-7000-8000-000000000002")
	sessionID, _ := identity.ParseSessionID("01999c20-9e33-7000-8000-000000000003")
	epoch, _ := identity.ParseSessionEpoch(1)
	token, _ := identity.ParseSessionToken(base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x41}, 32)))
	seed, err := fixture.NewSeed(
		allowed, accountID, vaultID, sessionID, epoch, token,
		cryptocontent.VaultDEKMetadata{
			VaultID: vaultID, DEKVersion: 1, KEKReference: "local-fixture://key/1",
			WrappedDEK:     base64.RawURLEncoding.EncodeToString(bytes.Repeat([]byte{0x52}, 32)),
			CreatedAtMilli: fixture.FixtureTimestamp,
		},
	)
	if err != nil {
		t.Fatal(err)
	}
	return seed
}
