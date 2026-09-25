package stripebilling

import (
	"context"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	APIVersion             = "2026-02-25.clover"
	WebhookToleranceMillis = int64(5 * 60 * 1_000)
	MaxWebhookBytes        = 256 * 1_024
	MaxSignatureHeader     = 8_192
	Provider               = billing.Provider("stripe")
)

type RuntimeMode string

const (
	ModeTest RuntimeMode = "test"
	ModeLive RuntimeMode = "live"
)

type Configuration struct {
	Mode           RuntimeMode
	APIVersion     string
	PriceReference string
	SuccessURL     string
	CancelURL      string
}

type BillingPeriod string

const (
	BillingMonthly BillingPeriod = "monthly"
	BillingAnnual  BillingPeriod = "annual"
)

type ContractOffer struct {
	OfferVersion      string
	DisclosureVersion string
	BillingPeriod     BillingPeriod
	RenewalChargeYen  int64
}

type HostedCheckoutContract struct {
	EvidenceID string
	OfferHash  string
	Offer      ContractOffer
}

type HostedCheckoutCommand struct {
	SubscriptionID   billing.SubscriptionID
	CheckoutIntentID billing.CheckoutIntentID
	CreatedAt        int64
	Contract         HostedCheckoutContract
}

type FormField struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type CheckoutCreateCommand struct {
	APIVersion       string
	IdempotencyKey   billing.CheckoutIntentID
	PriceReference   string
	SuccessURL       string
	CancelURL        string
	SubscriptionID   billing.SubscriptionID
	CheckoutIntentID billing.CheckoutIntentID
	Contract         HostedCheckoutContract
	SubmitMessage    string
}

func (command CheckoutCreateCommand) FormFields() []FormField {
	contract := command.Contract
	return []FormField{
		{Name: "mode", Value: "subscription"},
		{Name: "submit_type", Value: "subscribe"},
		{Name: "line_items[0][price]", Value: command.PriceReference},
		{Name: "line_items[0][quantity]", Value: "1"},
		{Name: "payment_method_collection", Value: "always"},
		{Name: "payment_method_options[card][request_three_d_secure]", Value: "any"},
		{Name: "subscription_data[trial_period_days]", Value: "14"},
		{Name: "subscription_data[trial_settings][end_behavior][missing_payment_method]", Value: "cancel"},
		{Name: "client_reference_id", Value: string(command.CheckoutIntentID)},
		{Name: "metadata[billing_subscription_id]", Value: string(command.SubscriptionID)},
		{Name: "metadata[checkout_intent_id]", Value: string(command.CheckoutIntentID)},
		{Name: "metadata[contract_evidence_id]", Value: contract.EvidenceID},
		{Name: "metadata[contract_offer_hash]", Value: contract.OfferHash},
		{Name: "metadata[contract_offer_version]", Value: contract.Offer.OfferVersion},
		{Name: "metadata[contract_disclosure_version]", Value: contract.Offer.DisclosureVersion},
		{Name: "subscription_data[metadata][billing_subscription_id]", Value: string(command.SubscriptionID)},
		{Name: "subscription_data[metadata][contract_evidence_id]", Value: contract.EvidenceID},
		{Name: "subscription_data[metadata][contract_offer_hash]", Value: contract.OfferHash},
		{Name: "custom_text[submit][message]", Value: command.SubmitMessage},
		{Name: "success_url", Value: command.SuccessURL},
		{Name: "cancel_url", Value: command.CancelURL},
	}
}

// CheckoutProviderResponse is untrusted data returned by the provider SDK.
type CheckoutProviderResponse struct {
	ID                string
	Object            string
	Mode              string
	LiveMode          bool
	ClientReferenceID string
	Metadata          map[string]string
	URL               string
}

type CheckoutResponse struct {
	ProviderCheckoutReference billing.ProviderCheckoutReference
	CheckoutURL               string
}

// ProviderSubscriptionSnapshot is the smallest provider-neutral shape needed
// from a Stripe Subscription retrieve response. Every value is validated by
// DecodeReconciliationSnapshot before entering the billing core.
type ProviderSubscriptionSnapshot struct {
	Subscription        ProviderSubscription
	SetupIntent         *ProviderSetupIntent
	LatestInvoice       *ProviderInvoice
	LatestPaymentIntent *ProviderPaymentIntent
}

type ProviderSubscription struct {
	ID                   string
	Object               string
	Customer             string
	Status               string
	CreatedSeconds       int64
	Metadata             map[string]string
	TrialStartSeconds    *int64
	TrialEndSeconds      *int64
	DefaultPaymentMethod *string
	CancelAtSeconds      *int64
	CancelledAtSeconds   *int64
	EndedAtSeconds       *int64
}

type ProviderSetupIntent struct {
	ID             string
	Object         string
	Status         string
	Usage          string
	Customer       string
	PaymentMethod  *string
	CreatedSeconds int64
}

type ProviderInvoice struct {
	ID                    string
	Object                string
	Customer              string
	Status                string
	PeriodStartSeconds    int64
	PeriodEndSeconds      int64
	SubscriptionReference string
	SubscriptionID        string
}

type ProviderPaymentIntent struct {
	ID             string
	Object         string
	Status         string
	Customer       string
	Invoice        string
	CreatedSeconds int64
}

type SnapshotPlan struct {
	SnapshotID                    billing.ReconciliationSnapshotID
	SubscriptionID                billing.SubscriptionID
	ProviderSubscriptionReference billing.ProviderSubscriptionReference
	ObservedAt                    int64
	RecordedAt                    int64
}

type EventPlanKind string

const (
	EventFact        EventPlanKind = "fact"
	EventSnapshot    EventPlanKind = "snapshot"
	EventUnsupported EventPlanKind = "unsupported"
	EventRejected    EventPlanKind = "rejected"
)

type RejectionReason string

const (
	ReasonInvalidInput              RejectionReason = "invalid-input"
	ReasonBillingRejected           RejectionReason = "billing-rejected"
	ReasonProviderUnavailable       RejectionReason = "provider-unavailable"
	ReasonMalformedProviderResponse RejectionReason = "malformed-provider-response"
	ReasonProviderMappingMismatch   RejectionReason = "provider-mapping-mismatch"
	ReasonInvalidSignature          RejectionReason = "invalid-signature"
	ReasonMalformedEvent            RejectionReason = "malformed-event"
	ReasonRuntimeModeMismatch       RejectionReason = "runtime-mode-mismatch"
	ReasonAPIVersionMismatch        RejectionReason = "api-version-mismatch"
)

type EventPlan struct {
	Kind     EventPlanKind
	Fact     *billing.VerifiedProviderFact
	Snapshot *SnapshotPlan
	Reason   RejectionReason
}

type HostedCheckoutResultKind string

const (
	HostedCheckoutRedirect HostedCheckoutResultKind = "redirect"
	HostedCheckoutRejected HostedCheckoutResultKind = "rejected"
)

type HostedCheckoutResult struct {
	Kind                      HostedCheckoutResultKind
	CheckoutURL               string
	ProviderCheckoutReference billing.ProviderCheckoutReference
	Reason                    RejectionReason
}

type WebhookRequest struct {
	RawBody         []byte
	SignatureHeader string
	ReceivedAt      int64
}

type WebhookResultKind string

const (
	WebhookAccepted WebhookResultKind = "accepted"
	WebhookIgnored  WebhookResultKind = "ignored"
	WebhookRejected WebhookResultKind = "rejected"
)

type WebhookResult struct {
	Kind    WebhookResultKind
	Outcome billing.CommandResultKind
	Reason  RejectionReason
}

type ReconciliationCommand struct {
	SnapshotID                    billing.ReconciliationSnapshotID
	SubscriptionID                billing.SubscriptionID
	ProviderSubscriptionReference billing.ProviderSubscriptionReference
	ObservedAt                    int64
	RecordedAt                    int64
}

type BillingPort interface {
	BeginCheckout(context.Context, identity.VaultContext, billing.BeginCheckoutCommand) (billing.CommandResult, error)
	RecordCheckoutOpened(context.Context, identity.VaultContext, billing.RecordCheckoutOpenedCommand) (billing.CommandResult, error)
	IngestVerifiedProviderFact(context.Context, billing.VerifiedProviderFact) (billing.CommandResult, error)
	ReconcileVerifiedSnapshot(context.Context, billing.ReconciliationSnapshot) (billing.CommandResult, error)
}

type ProviderPort interface {
	CreateCheckoutSession(context.Context, CheckoutCreateCommand) (CheckoutProviderResponse, error)
	RetrieveSubscriptionSnapshot(context.Context, billing.ProviderSubscriptionReference) (ProviderSubscriptionSnapshot, error)
}

type VerificationResult struct {
	Verified bool
	RawBody  []byte
}

type WebhookVerifierPort interface {
	Verify(WebhookRequest) VerificationResult
}
