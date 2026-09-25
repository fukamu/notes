package stripeadapter

import (
	"context"
	"errors"
	"net/http"
	"regexp"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/stripebilling"
	stripe "github.com/stripe/stripe-go/v84"
)

var (
	ErrInvalidProviderConfiguration = errors.New("invalid Stripe provider configuration")
	ErrInvalidProviderCommand       = errors.New("invalid Stripe provider command")
	apiKeyPattern                   = regexp.MustCompile(`^sk_(test|live)_[A-Za-z0-9]+$`)
	subscriptionReferencePattern    = regexp.MustCompile(`^sub_[A-Za-z0-9_]+$`)
)

type Provider struct {
	client *stripe.Client
}

func NewProvider(apiKey string, mode stripebilling.RuntimeMode, httpClient *http.Client) (*Provider, error) {
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	return newProviderWithBackends(apiKey, mode, stripe.NewBackendsWithConfig(&stripe.BackendConfig{
		HTTPClient: httpClient, EnableTelemetry: stripe.Bool(false),
		LeveledLogger: &stripe.LeveledLogger{Level: stripe.LevelNull},
	}))
}

// newProviderWithBackends keeps the official stripe-go client behind the
// provider port while allowing a local stub backend in tests. No caller can
// alter Stripe's pinned API version through this constructor.
func newProviderWithBackends(apiKey string, mode stripebilling.RuntimeMode, backends *stripe.Backends) (*Provider, error) {
	if mode != stripebilling.ModeTest && mode != stripebilling.ModeLive {
		return nil, ErrInvalidProviderConfiguration
	}
	expectedPrefix := "sk_test_"
	if mode == stripebilling.ModeLive {
		expectedPrefix = "sk_live_"
	}
	if stripe.APIVersion != stripebilling.APIVersion || backends == nil || len(apiKey) < 16 || len(apiKey) > 255 ||
		!apiKeyPattern.MatchString(apiKey) || len(apiKey) < len(expectedPrefix) || apiKey[:len(expectedPrefix)] != expectedPrefix {
		return nil, ErrInvalidProviderConfiguration
	}
	return &Provider{client: stripe.NewClient(apiKey, stripe.WithBackends(backends))}, nil
}

func (provider *Provider) CreateCheckoutSession(ctx context.Context, command stripebilling.CheckoutCreateCommand) (stripebilling.CheckoutProviderResponse, error) {
	if provider == nil || provider.client == nil || command.APIVersion != stripebilling.APIVersion {
		return stripebilling.CheckoutProviderResponse{}, ErrInvalidProviderCommand
	}
	params := &stripe.CheckoutSessionCreateParams{
		Params:                  stripe.Params{IdempotencyKey: stripe.String(string(command.IdempotencyKey))},
		Mode:                    stripe.String("subscription"),
		SubmitType:              stripe.String("subscribe"),
		LineItems:               []*stripe.CheckoutSessionCreateLineItemParams{{Price: stripe.String(command.PriceReference), Quantity: stripe.Int64(1)}},
		PaymentMethodCollection: stripe.String("always"),
		PaymentMethodOptions: &stripe.CheckoutSessionCreatePaymentMethodOptionsParams{
			Card: &stripe.CheckoutSessionCreatePaymentMethodOptionsCardParams{RequestThreeDSecure: stripe.String("any")},
		},
		SubscriptionData: &stripe.CheckoutSessionCreateSubscriptionDataParams{
			TrialPeriodDays: stripe.Int64(14),
			TrialSettings: &stripe.CheckoutSessionCreateSubscriptionDataTrialSettingsParams{
				EndBehavior: &stripe.CheckoutSessionCreateSubscriptionDataTrialSettingsEndBehaviorParams{MissingPaymentMethod: stripe.String("cancel")},
			},
			Metadata: map[string]string{
				"billing_subscription_id": string(command.SubscriptionID),
				"contract_evidence_id":    command.Contract.EvidenceID,
				"contract_offer_hash":     command.Contract.OfferHash,
			},
		},
		ClientReferenceID: stripe.String(string(command.CheckoutIntentID)),
		Metadata: map[string]string{
			"billing_subscription_id":     string(command.SubscriptionID),
			"checkout_intent_id":          string(command.CheckoutIntentID),
			"contract_evidence_id":        command.Contract.EvidenceID,
			"contract_offer_hash":         command.Contract.OfferHash,
			"contract_offer_version":      command.Contract.Offer.OfferVersion,
			"contract_disclosure_version": command.Contract.Offer.DisclosureVersion,
		},
		CustomText: &stripe.CheckoutSessionCreateCustomTextParams{
			Submit: &stripe.CheckoutSessionCreateCustomTextSubmitParams{Message: stripe.String(command.SubmitMessage)},
		},
		SuccessURL: stripe.String(command.SuccessURL),
		CancelURL:  stripe.String(command.CancelURL),
	}
	session, err := provider.client.V1CheckoutSessions.Create(ctx, params)
	if err != nil {
		return stripebilling.CheckoutProviderResponse{}, err
	}
	return stripebilling.CheckoutProviderResponse{
		ID: session.ID, Object: session.Object, Mode: string(session.Mode), LiveMode: session.Livemode,
		ClientReferenceID: session.ClientReferenceID, Metadata: cloneMetadata(session.Metadata), URL: session.URL,
	}, nil
}

func (provider *Provider) RetrieveSubscriptionSnapshot(ctx context.Context, reference billing.ProviderSubscriptionReference) (stripebilling.ProviderSubscriptionSnapshot, error) {
	if provider == nil || provider.client == nil {
		return stripebilling.ProviderSubscriptionSnapshot{}, ErrInvalidProviderCommand
	}
	validatedReference, err := billing.ParseProviderSubscriptionReference(string(reference))
	if err != nil || len(validatedReference) > 255 || !subscriptionReferencePattern.MatchString(string(validatedReference)) {
		return stripebilling.ProviderSubscriptionSnapshot{}, ErrInvalidProviderCommand
	}
	params := &stripe.SubscriptionRetrieveParams{}
	for _, expansion := range []string{
		"customer",
		"default_payment_method",
		"pending_setup_intent",
		"pending_setup_intent.customer",
		"pending_setup_intent.payment_method",
		"latest_invoice",
		"latest_invoice.customer",
		"latest_invoice.parent.subscription_details.subscription",
		"latest_invoice.payments",
	} {
		params.AddExpand(expansion)
	}
	subscription, err := provider.client.V1Subscriptions.Retrieve(ctx, string(validatedReference), params)
	if err != nil {
		return stripebilling.ProviderSubscriptionSnapshot{}, err
	}
	result := stripebilling.ProviderSubscriptionSnapshot{Subscription: mapSubscription(subscription)}
	if subscription.PendingSetupIntent != nil {
		result.SetupIntent = mapSetupIntent(subscription.PendingSetupIntent)
	}
	if subscription.LatestInvoice != nil {
		result.LatestInvoice = mapInvoice(subscription.LatestInvoice)
		paymentIntent := defaultPaymentIntent(subscription.LatestInvoice)
		if paymentIntent != nil && (paymentIntent.Status == "" || paymentIntent.Customer == nil) {
			paymentIntent, err = provider.client.V1PaymentIntents.Retrieve(ctx, paymentIntent.ID, nil)
			if err != nil {
				return stripebilling.ProviderSubscriptionSnapshot{}, err
			}
		}
		if paymentIntent != nil {
			result.LatestPaymentIntent = mapPaymentIntent(paymentIntent, subscription.LatestInvoice.ID)
		}
	}
	return result, nil
}

func mapSubscription(input *stripe.Subscription) stripebilling.ProviderSubscription {
	return stripebilling.ProviderSubscription{
		ID: input.ID, Object: input.Object, Customer: customerID(input.Customer), Status: string(input.Status),
		CreatedSeconds: input.Created, Metadata: cloneMetadata(input.Metadata),
		TrialStartSeconds: optionalSeconds(input.TrialStart), TrialEndSeconds: optionalSeconds(input.TrialEnd),
		DefaultPaymentMethod: paymentMethodID(input.DefaultPaymentMethod), CancelAtSeconds: optionalSeconds(input.CancelAt),
		CancelledAtSeconds: optionalSeconds(input.CanceledAt), EndedAtSeconds: optionalSeconds(input.EndedAt),
	}
}

func mapSetupIntent(input *stripe.SetupIntent) *stripebilling.ProviderSetupIntent {
	if input == nil {
		return nil
	}
	return &stripebilling.ProviderSetupIntent{
		ID: input.ID, Object: input.Object, Status: string(input.Status), Usage: string(input.Usage),
		Customer: customerID(input.Customer), PaymentMethod: paymentMethodID(input.PaymentMethod), CreatedSeconds: input.Created,
	}
}

func mapInvoice(input *stripe.Invoice) *stripebilling.ProviderInvoice {
	if input == nil {
		return nil
	}
	providerSubscription := ""
	metadataSubscriptionID := ""
	if input.Parent != nil && input.Parent.SubscriptionDetails != nil {
		providerSubscription = subscriptionID(input.Parent.SubscriptionDetails.Subscription)
		metadataSubscriptionID = input.Parent.SubscriptionDetails.Metadata["billing_subscription_id"]
	}
	return &stripebilling.ProviderInvoice{
		ID: input.ID, Object: input.Object, Customer: customerID(input.Customer),
		Status: string(input.Status), PeriodStartSeconds: input.PeriodStart, PeriodEndSeconds: input.PeriodEnd,
		SubscriptionReference: providerSubscription, SubscriptionID: metadataSubscriptionID,
	}
}

func defaultPaymentIntent(invoice *stripe.Invoice) *stripe.PaymentIntent {
	if invoice == nil || invoice.Payments == nil {
		return nil
	}
	var fallback *stripe.PaymentIntent
	for _, payment := range invoice.Payments.Data {
		if payment == nil || payment.Payment == nil || payment.Payment.PaymentIntent == nil {
			continue
		}
		if fallback == nil {
			fallback = payment.Payment.PaymentIntent
		}
		if payment.IsDefault {
			return payment.Payment.PaymentIntent
		}
	}
	return fallback
}

func mapPaymentIntent(input *stripe.PaymentIntent, invoiceID string) *stripebilling.ProviderPaymentIntent {
	if input == nil {
		return nil
	}
	return &stripebilling.ProviderPaymentIntent{
		ID: input.ID, Object: input.Object, Status: string(input.Status), Customer: customerID(input.Customer),
		Invoice: invoiceID, CreatedSeconds: input.Created,
	}
}

// stripe-go represents expandable references as pointers whose ID is populated
// even when the full object was not expanded. These helpers copy only that ID.
func customerID(input *stripe.Customer) string {
	if input == nil {
		return ""
	}
	return input.ID
}

func paymentMethodID(input *stripe.PaymentMethod) *string {
	if input == nil || input.ID == "" {
		return nil
	}
	value := input.ID
	return &value
}

func subscriptionID(input *stripe.Subscription) string {
	if input == nil {
		return ""
	}
	return input.ID
}

func optionalSeconds(value int64) *int64 {
	if value == 0 {
		return nil
	}
	copy := value
	return &copy
}

func cloneMetadata(values map[string]string) map[string]string {
	if values == nil {
		return nil
	}
	cloned := make(map[string]string, len(values))
	for key, value := range values {
		cloned[key] = value
	}
	return cloned
}
