package localcommerce

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/legal"
	fixture "github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/fukamu/notes/backend/internal/stripebilling"
)

var ErrInvalidProviderConfiguration = errors.New("invalid local commerce provider configuration")

const localOfferHash = "sha256:19edccf0f78bed73624638cb28459a185150fa7f945bd694213fe7d851f71a9d"

type subscriptionReader interface {
	FindByOwner(context.Context, billing.OwnerScope) (*billing.SubscriptionRecord, error)
}

type entitlementReader interface {
	FindProjection(context.Context, identity.VaultContext) (*entitlement.ProjectionRecord, error)
}

// Provider proves the exact seeded local billing and entitlement facts before
// acknowledging a checkout or cancellation. It performs no mutation and has
// no network or provider client dependency.
type Provider struct {
	context       identity.VaultContext
	expected      fixture.Seed
	subscriptions subscriptionReader
	entitlements  entitlementReader
}

var (
	_ legal.ContractCheckoutProvider               = (*Provider)(nil)
	_ billing.SubscriptionCancellationProviderPort = (*Provider)(nil)
)

func NewProvider(
	seed fixture.Seed,
	subscriptions subscriptionReader,
	entitlements entitlementReader,
) (*Provider, error) {
	if !fixture.ValidSeed(seed) || subscriptions == nil || entitlements == nil {
		return nil, ErrInvalidProviderConfiguration
	}
	return &Provider{
		context: seed.Context, expected: seed,
		subscriptions: subscriptions, entitlements: entitlements,
	}, nil
}

func (provider *Provider) BeginHostedCheckout(
	ctx context.Context,
	vaultContext identity.VaultContext,
	command stripebilling.HostedCheckoutCommand,
) stripebilling.HostedCheckoutResult {
	if provider == nil || vaultContext != provider.context || !validCheckoutCommand(command) ||
		provider.verifySeededFacts(ctx) != nil {
		return stripebilling.HostedCheckoutResult{
			Kind: stripebilling.HostedCheckoutRejected, Reason: stripebilling.ReasonProviderMappingMismatch,
		}
	}
	return stripebilling.HostedCheckoutResult{Kind: stripebilling.HostedCheckoutLocalConfirmed}
}

func (provider *Provider) CancelSubscription(
	ctx context.Context,
	command billing.ProviderCancellationCommand,
) (billing.ProviderCancellationObservation, error) {
	if provider == nil || command.Effect != billing.ProviderCancellationPeriodEnd ||
		command.Provider != provider.expected.Subscription.Provider ||
		command.ProviderSubscriptionReference != provider.expected.Subscription.ProviderSubscriptionReference ||
		provider.verifySeededFacts(ctx) != nil {
		return billing.ProviderCancellationObservation{
			Kind:     billing.ProviderCancellationTerminalFailure,
			Provider: command.Provider, ProviderSubscriptionReference: command.ProviderSubscriptionReference,
			IdempotencyKey: command.IdempotencyKey, ObservedAt: identity.MaximumSafeInteger,
		}, nil
	}
	return billing.ProviderCancellationObservation{
		Kind:     billing.ProviderCancellationScheduled,
		Provider: command.Provider, ProviderSubscriptionReference: command.ProviderSubscriptionReference,
		IdempotencyKey: command.IdempotencyKey, ObservedAt: identity.MaximumSafeInteger,
		AccessEndsAt: identity.MaximumSafeInteger,
	}, nil
}

func (provider *Provider) verifySeededFacts(ctx context.Context) error {
	if provider == nil || ctx == nil || provider.subscriptions == nil || provider.entitlements == nil {
		return ErrInvalidProviderConfiguration
	}
	storedSubscription, err := provider.subscriptions.FindByOwner(ctx, billing.OwnerScope{
		AccountID: provider.context.AccountID, VaultID: provider.context.VaultID,
	})
	if err != nil || storedSubscription == nil || !matchesSubscription(*storedSubscription, provider.expected.Subscription) {
		return ErrInvalidProviderConfiguration
	}
	storedEntitlement, err := provider.entitlements.FindProjection(ctx, provider.context)
	if err != nil || storedEntitlement == nil || *storedEntitlement != provider.expected.Entitlement {
		return ErrInvalidProviderConfiguration
	}
	return nil
}

func validCheckoutCommand(command stripebilling.HostedCheckoutCommand) bool {
	_, subscriptionErr := billing.ParseSubscriptionID(string(command.SubscriptionID))
	_, checkoutErr := billing.ParseCheckoutIntentID(string(command.CheckoutIntentID))
	_, evidenceErr := legal.ParseContractEvidenceID(command.Contract.EvidenceID)
	_, hashErr := legal.ParseContractOfferHash(command.Contract.OfferHash)
	return subscriptionErr == nil && checkoutErr == nil && evidenceErr == nil && hashErr == nil &&
		string(command.SubscriptionID) == command.Contract.EvidenceID &&
		command.Contract.OfferHash == localOfferHash &&
		command.CreatedAt >= 0 && command.CreatedAt <= identity.MaximumSafeInteger &&
		command.Contract.Offer.OfferVersion == "legal-commerce-v1:2026-09-15" &&
		command.Contract.Offer.DisclosureVersion == "2026-09-15" &&
		command.Contract.Offer.BillingPeriod == stripebilling.BillingMonthly &&
		command.Contract.Offer.RenewalChargeYen == 980
}

func matchesSubscription(actual billing.SubscriptionRecord, expected billing.SubscriptionRecord) bool {
	return billing.ValidRecord(actual) && actual.SubscriptionID == expected.SubscriptionID &&
		actual.AccountID == expected.AccountID && actual.VaultID == expected.VaultID &&
		actual.Provider == expected.Provider &&
		actual.ProviderCustomerReference == expected.ProviderCustomerReference &&
		actual.ProviderSubscriptionReference == expected.ProviderSubscriptionReference &&
		actual.Version == expected.Version && actual.Lifecycle == expected.Lifecycle &&
		actual.PaymentMethodReady == expected.PaymentMethodReady &&
		actual.LastPaidInvoiceReference == expected.LastPaidInvoiceReference &&
		actual.CreatedAt == expected.CreatedAt && actual.UpdatedAt == expected.UpdatedAt &&
		timestampsEqual(actual.PaymentMethodUpdatedAt, expected.PaymentMethodUpdatedAt) &&
		timestampsEqual(actual.LastPaidAt, expected.LastPaidAt) &&
		timestampsEqual(actual.TrialObservedAt, expected.TrialObservedAt) &&
		timestampsEqual(actual.LastDelinquencyAt, expected.LastDelinquencyAt) &&
		timestampsEqual(actual.LastReconciledAt, expected.LastReconciledAt) &&
		timestampsEqual(actual.CancelAt, expected.CancelAt) &&
		timestampsEqual(actual.CancellationUpdatedAt, expected.CancellationUpdatedAt)
}

func timestampsEqual(left *int64, right *int64) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
