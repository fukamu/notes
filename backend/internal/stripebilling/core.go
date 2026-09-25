package stripebilling

import (
	"encoding/json"
	"fmt"
	"net/url"
	"unicode/utf8"

	"github.com/fukamu/notes/backend/internal/billing"
)

func PlanCheckout(configuration Configuration, command HostedCheckoutCommand) (CheckoutCreateCommand, error) {
	if !configuration.Valid() || !validMillis(command.CreatedAt) || !validContract(command.Contract) {
		return CheckoutCreateCommand{}, ErrInvalidCheckout
	}
	if _, err := billing.ParseSubscriptionID(string(command.SubscriptionID)); err != nil {
		return CheckoutCreateCommand{}, ErrInvalidCheckout
	}
	if _, err := billing.ParseCheckoutIntentID(string(command.CheckoutIntentID)); err != nil {
		return CheckoutCreateCommand{}, ErrInvalidCheckout
	}
	planned := CheckoutCreateCommand{
		APIVersion: APIVersion, IdempotencyKey: command.CheckoutIntentID,
		PriceReference: configuration.PriceReference, SuccessURL: configuration.SuccessURL, CancelURL: configuration.CancelURL,
		SubscriptionID: command.SubscriptionID, CheckoutIntentID: command.CheckoutIntentID,
		Contract: command.Contract, SubmitMessage: ContractSubmitMessage(command.Contract.Offer),
	}
	if len(planned.SubmitMessage) > 1_200 {
		return CheckoutCreateCommand{}, ErrInvalidCheckout
	}
	return planned, nil
}

func ContractSubmitMessage(offer ContractOffer) string {
	cadence := "毎年"
	if offer.BillingPeriod == BillingMonthly {
		cadence = "毎月"
	}
	return fmt.Sprintf("14日間は0円です。15日目から税込%d円を%s自動課金します。支払い方法の登録が必要です。支払い失敗または追加認証が必要な場合はオンライン利用を停止し、invoice.paid確認後に再開します。解約と退会は別手続です。", offer.RenewalChargeYen, cadence)
}

func DecodeCheckoutResponse(input CheckoutProviderResponse, expected HostedCheckoutCommand, mode RuntimeMode) (CheckoutResponse, RejectionReason) {
	checkoutReference, checkoutOK := parseCheckoutReference(input.ID)
	subscriptionID, subscriptionOK := stringValue(input.Metadata, "billing_subscription_id")
	checkoutID, checkoutIDOK := stringValue(input.Metadata, "checkout_intent_id")
	evidenceID, evidenceOK := stringValue(input.Metadata, "contract_evidence_id")
	offerHash, hashOK := stringValue(input.Metadata, "contract_offer_hash")
	offerVersion, offerOK := stringValue(input.Metadata, "contract_offer_version")
	disclosureVersion, disclosureOK := stringValue(input.Metadata, "contract_disclosure_version")
	if !checkoutOK || input.Object != "checkout.session" || input.Mode != "subscription" ||
		input.ClientReferenceID == "" || !subscriptionOK || !checkoutIDOK || !evidenceOK || !hashOK || !offerOK || !disclosureOK {
		return CheckoutResponse{}, ReasonMalformedProviderResponse
	}
	if input.LiveMode != (mode == ModeLive) || input.ClientReferenceID != string(expected.CheckoutIntentID) ||
		subscriptionID != string(expected.SubscriptionID) || checkoutID != string(expected.CheckoutIntentID) ||
		evidenceID != expected.Contract.EvidenceID || offerHash != expected.Contract.OfferHash ||
		offerVersion != expected.Contract.Offer.OfferVersion || disclosureVersion != expected.Contract.Offer.DisclosureVersion {
		return CheckoutResponse{}, ReasonProviderMappingMismatch
	}
	if !validCheckoutURL(input.URL) {
		return CheckoutResponse{}, ReasonMalformedProviderResponse
	}
	return CheckoutResponse{ProviderCheckoutReference: checkoutReference, CheckoutURL: input.URL}, ""
}

func DecodeEventPlan(rawBody []byte, mode RuntimeMode, apiVersion string, receivedAt int64) EventPlan {
	if len(rawBody) == 0 || len(rawBody) > MaxWebhookBytes || !utf8.Valid(rawBody) || !validMillis(receivedAt) {
		return rejectedEvent(ReasonMalformedEvent)
	}
	var envelope rawEventEnvelope
	if err := json.Unmarshal(rawBody, &envelope); err != nil {
		return rejectedEvent(ReasonMalformedEvent)
	}
	createdAt, createdOK := requiredSeconds(envelope.Created)
	eventID, idOK := parseEventID(envelope.ID)
	if !createdOK || !idOK || envelope.Object != "event" || envelope.LiveMode == nil || envelope.APIVersion == "" ||
		envelope.Type == "" || len(envelope.Type) > 128 || len(envelope.Data.Object) == 0 {
		return rejectedEvent(ReasonMalformedEvent)
	}
	if *envelope.LiveMode != (mode == ModeLive) {
		return rejectedEvent(ReasonRuntimeModeMismatch)
	}
	if apiVersion != APIVersion || envelope.APIVersion != apiVersion {
		return rejectedEvent(ReasonAPIVersionMismatch)
	}
	if createdAt > receivedAt {
		return rejectedEvent(ReasonMalformedEvent)
	}
	event := decodedEvent{ID: eventID, CreatedAt: createdAt, LiveMode: *envelope.LiveMode, Type: envelope.Type, Object: envelope.Data.Object}
	switch event.Type {
	case "checkout.session.completed":
		return checkoutCompletedPlan(event, receivedAt)
	case "invoice.paid", "invoice.payment_failed", "invoice.payment_action_required":
		return invoicePlan(event, receivedAt)
	case "setup_intent.succeeded":
		return setupIntentPlan(event, receivedAt)
	case "customer.subscription.updated", "customer.subscription.deleted":
		return subscriptionPlan(event, receivedAt)
	default:
		return EventPlan{Kind: EventUnsupported}
	}
}

func DecodeReconciliationSnapshot(input ProviderSubscriptionSnapshot, plan SnapshotPlan) (billing.ReconciliationSnapshot, bool) {
	if !validMillis(plan.ObservedAt) || !validMillis(plan.RecordedAt) || plan.RecordedAt < plan.ObservedAt {
		return billing.ReconciliationSnapshot{}, false
	}
	subscription, ok := validateProviderSubscription(input.Subscription, plan)
	if !ok {
		return billing.ReconciliationSnapshot{}, false
	}
	paymentReady, paymentUpdatedAt, setupOK := validateSetupIntent(input.SetupIntent, subscription, plan.ObservedAt)
	if !setupOK {
		return billing.ReconciliationSnapshot{}, false
	}
	trial, trialOK := reconciliationTrial(subscription, paymentReady)
	if !trialOK {
		return billing.ReconciliationSnapshot{}, false
	}
	invoice, invoiceOK := validateProviderInvoice(input.LatestInvoice, subscription, plan)
	if !invoiceOK {
		return billing.ReconciliationSnapshot{}, false
	}
	paymentIntent, paymentIntentOK := validatePaymentIntent(input.LatestPaymentIntent, invoice, subscription, plan.ObservedAt)
	if !paymentIntentOK {
		return billing.ReconciliationSnapshot{}, false
	}
	var paidInvoice *billing.ReconciliationPaidInvoice
	if invoice != nil && invoice.Paid && invoice.Status == "paid" {
		if invoice.PaidAt == nil {
			return billing.ReconciliationSnapshot{}, false
		}
		paidInvoice = &billing.ReconciliationPaidInvoice{
			InvoiceReference: invoice.ID, PaidAt: *invoice.PaidAt,
			PeriodStartedAt: invoice.PeriodStart, PeriodEndsAt: invoice.PeriodEnd,
		}
	}
	var delinquency *billing.ReconciliationDelinquency
	if invoice != nil && paymentIntent != nil && !invoice.Paid && invoice.Status == "open" {
		switch paymentIntent.Status {
		case "requires_action":
			delinquency = &billing.ReconciliationDelinquency{Reason: billing.DelinquencyPaymentActionRequired, InvoiceReference: invoice.ID, OccurredAt: paymentIntent.CreatedAt}
		case "requires_payment_method":
			delinquency = &billing.ReconciliationDelinquency{Reason: billing.DelinquencyPaymentFailed, InvoiceReference: invoice.ID, OccurredAt: paymentIntent.CreatedAt}
		}
	}
	var cancelledAt *int64
	if subscription.Status == "canceled" {
		value := plan.ObservedAt
		if subscription.EndedAt != nil {
			value = *subscription.EndedAt
		} else if subscription.CancelledAt != nil {
			value = *subscription.CancelledAt
		}
		cancelledAt = &value
	}
	return billing.ReconciliationSnapshot{
		SnapshotID: plan.SnapshotID, SubscriptionID: plan.SubscriptionID, Provider: Provider,
		ProviderCustomerReference: subscription.Customer, ProviderSubscriptionReference: subscription.ID,
		ObservedAt: plan.ObservedAt, RecordedAt: plan.RecordedAt,
		PaymentMethodReady: paymentReady, PaymentMethodUpdatedAt: paymentUpdatedAt,
		Trial: trial, LatestPaidInvoice: paidInvoice, Delinquency: delinquency,
		CancelAt: subscription.CancelAt, CancellationUpdatedAt: plan.ObservedAt, CancelledAt: cancelledAt,
	}, true
}

type rawEventEnvelope struct {
	ID         string `json:"id"`
	Object     string `json:"object"`
	APIVersion string `json:"api_version"`
	Created    *int64 `json:"created"`
	LiveMode   *bool  `json:"livemode"`
	Type       string `json:"type"`
	Data       struct {
		Object json.RawMessage `json:"object"`
	} `json:"data"`
}

type decodedEvent struct {
	ID        billing.ProviderEventID
	CreatedAt int64
	LiveMode  bool
	Type      string
	Object    json.RawMessage
}

type checkoutMetadata struct {
	SubscriptionID     billing.SubscriptionID
	CheckoutIntentID   billing.CheckoutIntentID
	ContractEvidenceID string
	ContractOfferHash  string
	OfferVersion       string
	DisclosureVersion  string
}

type rawCheckoutSession struct {
	ID                string            `json:"id"`
	Object            string            `json:"object"`
	Mode              string            `json:"mode"`
	Status            string            `json:"status"`
	LiveMode          *bool             `json:"livemode"`
	Customer          string            `json:"customer"`
	Subscription      string            `json:"subscription"`
	ClientReferenceID string            `json:"client_reference_id"`
	Metadata          map[string]string `json:"metadata"`
}

type rawInvoice struct {
	ID          string `json:"id"`
	Object      string `json:"object"`
	Customer    string `json:"customer"`
	Status      string `json:"status"`
	PeriodStart *int64 `json:"period_start"`
	PeriodEnd   *int64 `json:"period_end"`
	Parent      struct {
		Type                string `json:"type"`
		SubscriptionDetails struct {
			Subscription string            `json:"subscription"`
			Metadata     map[string]string `json:"metadata"`
		} `json:"subscription_details"`
	} `json:"parent"`
}

type rawSetupIntent struct {
	ID            string            `json:"id"`
	Object        string            `json:"object"`
	Status        string            `json:"status"`
	Usage         string            `json:"usage"`
	Customer      string            `json:"customer"`
	PaymentMethod string            `json:"payment_method"`
	Metadata      map[string]string `json:"metadata"`
}

type rawSubscription struct {
	ID       string            `json:"id"`
	Object   string            `json:"object"`
	Customer string            `json:"customer"`
	Status   string            `json:"status"`
	Metadata map[string]string `json:"metadata"`
	CancelAt *int64            `json:"cancel_at"`
	EndedAt  *int64            `json:"ended_at"`
}

type normalizedSubscription struct {
	ID                   billing.ProviderSubscriptionReference
	Customer             billing.ProviderCustomerReference
	Status               string
	CreatedAt            int64
	TrialStart           *int64
	TrialEnd             *int64
	DefaultPaymentMethod string
	CancelAt             *int64
	CancelledAt          *int64
	EndedAt              *int64
}

type normalizedInvoice struct {
	ID          billing.ProviderInvoiceReference
	Customer    billing.ProviderCustomerReference
	Paid        bool
	Status      string
	CreatedAt   int64
	PaidAt      *int64
	PeriodStart int64
	PeriodEnd   int64
}

type normalizedPaymentIntent struct {
	Status    string
	CreatedAt int64
}

func checkoutCompletedPlan(event decodedEvent, receivedAt int64) EventPlan {
	var session rawCheckoutSession
	if json.Unmarshal(event.Object, &session) != nil {
		return rejectedEvent(ReasonMalformedEvent)
	}
	metadata, ok := decodeCheckoutMetadata(session.Metadata)
	customer, customerOK := parseCustomerReference(session.Customer)
	providerSubscription, providerOK := parseSubscriptionReference(session.Subscription)
	if !ok || !customerOK || !providerOK || session.Object != "checkout.session" || session.Mode != "subscription" ||
		session.Status != "complete" || session.LiveMode == nil || *session.LiveMode != event.LiveMode ||
		session.ClientReferenceID != string(metadata.CheckoutIntentID) {
		return rejectedEvent(ReasonMalformedEvent)
	}
	_ = customer
	snapshotID, err := billing.ParseReconciliationSnapshotID(string(event.ID) + ":checkout")
	if err != nil {
		return rejectedEvent(ReasonMalformedEvent)
	}
	return EventPlan{Kind: EventSnapshot, Snapshot: &SnapshotPlan{
		SnapshotID: snapshotID, SubscriptionID: metadata.SubscriptionID,
		ProviderSubscriptionReference: providerSubscription, ObservedAt: event.CreatedAt, RecordedAt: receivedAt,
	}}
}

func invoicePlan(event decodedEvent, receivedAt int64) EventPlan {
	invoice, ok := decodeEventInvoice(event.Object)
	if !ok || invoice.PeriodEnd <= invoice.PeriodStart {
		return rejectedEvent(ReasonMalformedEvent)
	}
	var raw rawInvoice
	_ = json.Unmarshal(event.Object, &raw)
	subscriptionID, subOK := parseBillingSubscription(raw.Parent.SubscriptionDetails.Metadata)
	providerSubscription, providerOK := parseSubscriptionReference(raw.Parent.SubscriptionDetails.Subscription)
	if !subOK || !providerOK {
		return rejectedEvent(ReasonMalformedEvent)
	}
	fact := billing.VerifiedProviderFact{
		SubscriptionID: subscriptionID, Provider: Provider, EventID: event.ID,
		ProviderCustomerReference: invoice.Customer, ProviderSubscriptionReference: providerSubscription,
		OccurredAt: event.CreatedAt, RecordedAt: receivedAt, InvoiceReference: invoice.ID,
	}
	switch event.Type {
	case "invoice.paid":
		if !invoice.Paid || invoice.Status != "paid" {
			return rejectedEvent(ReasonMalformedEvent)
		}
		fact.Kind = billing.FactInvoicePaid
		fact.PaidPeriodStartedAt = invoice.PeriodStart
		fact.PaidPeriodEndsAt = invoice.PeriodEnd
	case "invoice.payment_failed":
		if invoice.Paid || invoice.Status != "open" {
			return rejectedEvent(ReasonMalformedEvent)
		}
		fact.Kind = billing.FactInvoicePaymentFailed
	case "invoice.payment_action_required":
		if invoice.Paid || invoice.Status != "open" {
			return rejectedEvent(ReasonMalformedEvent)
		}
		fact.Kind = billing.FactInvoicePaymentActionRequired
	default:
		return EventPlan{Kind: EventUnsupported}
	}
	return EventPlan{Kind: EventFact, Fact: &fact}
}

func setupIntentPlan(event decodedEvent, receivedAt int64) EventPlan {
	var setup rawSetupIntent
	if json.Unmarshal(event.Object, &setup) != nil || !validStripeID(setup.ID, "seti_") || setup.Object != "setup_intent" ||
		setup.Status != "succeeded" || setup.Usage != "off_session" || !validStripeID(setup.PaymentMethod, "pm_") {
		return rejectedEvent(ReasonMalformedEvent)
	}
	customer, customerOK := parseCustomerReference(setup.Customer)
	subscriptionID, subOK := parseBillingSubscription(setup.Metadata)
	providerSubscriptionValue, providerOK := stringValue(setup.Metadata, "provider_subscription_id")
	providerSubscription, providerParseOK := parseSubscriptionReference(providerSubscriptionValue)
	if !customerOK || !subOK || !providerOK || !providerParseOK {
		return rejectedEvent(ReasonMalformedEvent)
	}
	fact := billing.VerifiedProviderFact{
		Kind: billing.FactPaymentMethodUpdated, SubscriptionID: subscriptionID, Provider: Provider, EventID: event.ID,
		ProviderCustomerReference: customer, ProviderSubscriptionReference: providerSubscription,
		OccurredAt: event.CreatedAt, RecordedAt: receivedAt,
	}
	return EventPlan{Kind: EventFact, Fact: &fact}
}

func subscriptionPlan(event decodedEvent, receivedAt int64) EventPlan {
	var raw rawSubscription
	if json.Unmarshal(event.Object, &raw) != nil || raw.Object != "subscription" || !validSubscriptionStatus(raw.Status) {
		return rejectedEvent(ReasonMalformedEvent)
	}
	providerSubscription, providerOK := parseSubscriptionReference(raw.ID)
	customer, customerOK := parseCustomerReference(raw.Customer)
	subscriptionID, subOK := parseBillingSubscription(raw.Metadata)
	if !providerOK || !customerOK || !subOK {
		return rejectedEvent(ReasonMalformedEvent)
	}
	fact := billing.VerifiedProviderFact{
		SubscriptionID: subscriptionID, Provider: Provider, EventID: event.ID,
		ProviderCustomerReference: customer, ProviderSubscriptionReference: providerSubscription,
		OccurredAt: event.CreatedAt, RecordedAt: receivedAt,
	}
	if event.Type == "customer.subscription.deleted" {
		cancelledAt := event.CreatedAt
		if raw.EndedAt != nil {
			ended, ok := millisFromSeconds(*raw.EndedAt)
			if !ok {
				return rejectedEvent(ReasonMalformedEvent)
			}
			if ended > cancelledAt {
				cancelledAt = ended
			}
		}
		fact.Kind = billing.FactSubscriptionCancelled
		fact.CancelledAt = cancelledAt
		return EventPlan{Kind: EventFact, Fact: &fact}
	}
	if raw.CancelAt == nil {
		return EventPlan{Kind: EventUnsupported}
	}
	cancelAt, ok := millisFromSeconds(*raw.CancelAt)
	if !ok {
		return rejectedEvent(ReasonMalformedEvent)
	}
	if event.CreatedAt > cancelAt {
		cancelAt = event.CreatedAt
	}
	fact.Kind = billing.FactCancellationScheduled
	fact.CancelAt = cancelAt
	return EventPlan{Kind: EventFact, Fact: &fact}
}

func validateProviderSubscription(input ProviderSubscription, plan SnapshotPlan) (normalizedSubscription, bool) {
	id, idOK := parseSubscriptionReference(input.ID)
	customer, customerOK := parseCustomerReference(input.Customer)
	subscriptionValue, metadataOK := stringValue(input.Metadata, "billing_subscription_id")
	subscriptionID, subErr := billing.ParseSubscriptionID(subscriptionValue)
	created, createdOK := millisFromSeconds(input.CreatedSeconds)
	if !idOK || !customerOK || !metadataOK || subErr != nil || input.Object != "subscription" || !validSubscriptionStatus(input.Status) ||
		id != plan.ProviderSubscriptionReference || subscriptionID != plan.SubscriptionID || !createdOK ||
		created <= 0 || created > plan.ObservedAt {
		return normalizedSubscription{}, false
	}
	trialStart, trialStartOK := optionalSeconds(input.TrialStartSeconds)
	trialEnd, trialEndOK := optionalSeconds(input.TrialEndSeconds)
	cancelAt, cancelOK := optionalSeconds(input.CancelAtSeconds)
	cancelledAt, cancelledOK := optionalSeconds(input.CancelledAtSeconds)
	endedAt, endedOK := optionalSeconds(input.EndedAtSeconds)
	if !trialStartOK || !trialEndOK || !cancelOK || !cancelledOK || !endedOK {
		return normalizedSubscription{}, false
	}
	defaultPaymentMethod := ""
	if input.DefaultPaymentMethod != nil {
		if !validStripeID(*input.DefaultPaymentMethod, "pm_") {
			return normalizedSubscription{}, false
		}
		defaultPaymentMethod = *input.DefaultPaymentMethod
	}
	return normalizedSubscription{
		ID: id, Customer: customer, Status: input.Status, CreatedAt: created,
		TrialStart: trialStart, TrialEnd: trialEnd, DefaultPaymentMethod: defaultPaymentMethod,
		CancelAt: cancelAt, CancelledAt: cancelledAt, EndedAt: endedAt,
	}, true
}

func validateSetupIntent(input *ProviderSetupIntent, subscription normalizedSubscription, observedAt int64) (bool, int64, bool) {
	if input == nil {
		return false, subscription.CreatedAt, true
	}
	createdAt, createdOK := millisFromSeconds(input.CreatedSeconds)
	if !validStripeID(input.ID, "seti_") || input.Object != "setup_intent" || !validSetupStatus(input.Status) ||
		input.Usage != "off_session" || input.Customer != string(subscription.Customer) || !createdOK ||
		createdAt <= 0 || createdAt > observedAt {
		return false, 0, false
	}
	paymentMethod := ""
	if input.PaymentMethod != nil {
		if !validStripeID(*input.PaymentMethod, "pm_") {
			return false, 0, false
		}
		paymentMethod = *input.PaymentMethod
	}
	ready := input.Status == "succeeded" && paymentMethod != "" && paymentMethod == subscription.DefaultPaymentMethod
	return ready, createdAt, true
}

func reconciliationTrial(subscription normalizedSubscription, paymentReady bool) (*billing.ReconciliationTrial, bool) {
	if subscription.Status != "trialing" {
		return nil, true
	}
	if !paymentReady || subscription.TrialStart == nil || subscription.TrialEnd == nil ||
		*subscription.TrialEnd-*subscription.TrialStart != billing.TrialDurationMilliseconds {
		return nil, false
	}
	return &billing.ReconciliationTrial{StartedAt: *subscription.TrialStart, EndsAt: *subscription.TrialEnd, ObservedAt: subscription.CreatedAt}, true
}

func validateProviderInvoice(input *ProviderInvoice, subscription normalizedSubscription, plan SnapshotPlan) (*normalizedInvoice, bool) {
	if input == nil {
		return nil, true
	}
	id, idOK := parseInvoiceReference(input.ID)
	customer, customerOK := parseCustomerReference(input.Customer)
	providerSubscription, providerOK := parseSubscriptionReference(input.SubscriptionReference)
	subscriptionID, subErr := billing.ParseSubscriptionID(input.SubscriptionID)
	periodStart, startOK := millisFromSeconds(input.PeriodStartSeconds)
	periodEnd, endOK := millisFromSeconds(input.PeriodEndSeconds)
	createdAt, createdOK := millisFromSeconds(input.CreatedSeconds)
	paidAt, paidOK := optionalSeconds(input.PaidAtSeconds)
	paid := input.Status == "paid"
	if !idOK || !customerOK || !providerOK || subErr != nil || input.Object != "invoice" || !validInvoiceStatus(input.Status) ||
		customer != subscription.Customer || providerSubscription != subscription.ID || subscriptionID != plan.SubscriptionID ||
		!startOK || !endOK || !createdOK || !paidOK || periodEnd <= periodStart || createdAt <= 0 || createdAt > plan.ObservedAt ||
		paid != (paidAt != nil) || (paidAt != nil && (*paidAt <= 0 || *paidAt < createdAt || *paidAt > plan.ObservedAt)) {
		return nil, false
	}
	return &normalizedInvoice{
		ID: id, Customer: customer, Paid: paid, Status: input.Status, CreatedAt: createdAt,
		PaidAt: paidAt, PeriodStart: periodStart, PeriodEnd: periodEnd,
	}, true
}

func validatePaymentIntent(
	input *ProviderPaymentIntent,
	invoice *normalizedInvoice,
	subscription normalizedSubscription,
	observedAt int64,
) (*normalizedPaymentIntent, bool) {
	if input == nil {
		return nil, true
	}
	createdAt, createdOK := millisFromSeconds(input.CreatedSeconds)
	if invoice == nil || !validStripeID(input.ID, "pi_") || input.Object != "payment_intent" || !validPaymentIntentStatus(input.Status) ||
		input.Customer != string(subscription.Customer) || input.Invoice != string(invoice.ID) || !createdOK ||
		createdAt <= 0 || createdAt < invoice.CreatedAt || createdAt > observedAt {
		return nil, false
	}
	return &normalizedPaymentIntent{Status: input.Status, CreatedAt: createdAt}, true
}

func decodeEventInvoice(input json.RawMessage) (normalizedInvoice, bool) {
	var raw rawInvoice
	if json.Unmarshal(input, &raw) != nil || raw.PeriodStart == nil || raw.PeriodEnd == nil ||
		raw.Object != "invoice" || raw.Parent.Type != "subscription_details" || !validInvoiceStatus(raw.Status) {
		return normalizedInvoice{}, false
	}
	id, idOK := parseInvoiceReference(raw.ID)
	customer, customerOK := parseCustomerReference(raw.Customer)
	periodStart, startOK := millisFromSeconds(*raw.PeriodStart)
	periodEnd, endOK := millisFromSeconds(*raw.PeriodEnd)
	if !idOK || !customerOK || !startOK || !endOK {
		return normalizedInvoice{}, false
	}
	return normalizedInvoice{ID: id, Customer: customer, Paid: raw.Status == "paid", Status: raw.Status, PeriodStart: periodStart, PeriodEnd: periodEnd}, true
}

func decodeCheckoutMetadata(values map[string]string) (checkoutMetadata, bool) {
	subscriptionValue, subscriptionOK := stringValue(values, "billing_subscription_id")
	checkoutValue, checkoutOK := stringValue(values, "checkout_intent_id")
	evidenceID, evidenceOK := stringValue(values, "contract_evidence_id")
	offerHash, hashOK := stringValue(values, "contract_offer_hash")
	offerVersion, offerOK := stringValue(values, "contract_offer_version")
	disclosureVersion, disclosureOK := stringValue(values, "contract_disclosure_version")
	subscriptionID, subErr := billing.ParseSubscriptionID(subscriptionValue)
	checkoutID, checkoutErr := billing.ParseCheckoutIntentID(checkoutValue)
	if !subscriptionOK || !checkoutOK || !evidenceOK || !hashOK || !offerOK || !disclosureOK || subErr != nil || checkoutErr != nil ||
		!hashPattern.MatchString(offerHash) || !offerVersionPattern.MatchString(offerVersion) || !datePattern.MatchString(disclosureVersion) {
		return checkoutMetadata{}, false
	}
	if !uuidV7Pattern.MatchString(evidenceID) {
		return checkoutMetadata{}, false
	}
	return checkoutMetadata{SubscriptionID: subscriptionID, CheckoutIntentID: checkoutID, ContractEvidenceID: evidenceID, ContractOfferHash: offerHash, OfferVersion: offerVersion, DisclosureVersion: disclosureVersion}, true
}

func parseBillingSubscription(values map[string]string) (billing.SubscriptionID, bool) {
	value, ok := stringValue(values, "billing_subscription_id")
	if !ok {
		return "", false
	}
	parsed, err := billing.ParseSubscriptionID(value)
	return parsed, err == nil
}

func parseEventID(value string) (billing.ProviderEventID, bool) {
	if !validStripeID(value, "evt_") {
		return "", false
	}
	parsed, err := billing.ParseProviderEventID(value)
	return parsed, err == nil
}

func parseCustomerReference(value string) (billing.ProviderCustomerReference, bool) {
	if !validStripeID(value, "cus_") {
		return "", false
	}
	parsed, err := billing.ParseProviderCustomerReference(value)
	return parsed, err == nil
}

func parseSubscriptionReference(value string) (billing.ProviderSubscriptionReference, bool) {
	if !validStripeID(value, "sub_") {
		return "", false
	}
	parsed, err := billing.ParseProviderSubscriptionReference(value)
	return parsed, err == nil
}

func parseCheckoutReference(value string) (billing.ProviderCheckoutReference, bool) {
	if !validStripeID(value, "cs_") {
		return "", false
	}
	parsed, err := billing.ParseProviderCheckoutReference(value)
	return parsed, err == nil
}

func parseInvoiceReference(value string) (billing.ProviderInvoiceReference, bool) {
	if !validStripeID(value, "in_") {
		return "", false
	}
	parsed, err := billing.ParseProviderInvoiceReference(value)
	return parsed, err == nil
}

func requiredSeconds(value *int64) (int64, bool) {
	if value == nil {
		return 0, false
	}
	return millisFromSeconds(*value)
}

func optionalSeconds(value *int64) (*int64, bool) {
	if value == nil {
		return nil, true
	}
	millis, ok := millisFromSeconds(*value)
	if !ok {
		return nil, false
	}
	return &millis, true
}

func validSubscriptionStatus(value string) bool {
	switch value {
	case "incomplete", "incomplete_expired", "trialing", "active", "past_due", "canceled", "unpaid", "paused":
		return true
	default:
		return false
	}
}

func validInvoiceStatus(value string) bool {
	switch value {
	case "draft", "open", "paid", "uncollectible", "void":
		return true
	default:
		return false
	}
}

func validSetupStatus(value string) bool {
	switch value {
	case "requires_payment_method", "requires_confirmation", "requires_action", "processing", "canceled", "succeeded":
		return true
	default:
		return false
	}
}

func validPaymentIntentStatus(value string) bool {
	switch value {
	case "requires_payment_method", "requires_confirmation", "requires_action", "processing", "requires_capture", "canceled", "succeeded":
		return true
	default:
		return false
	}
}

func validCheckoutURL(value string) bool {
	if len(value) < 1 || len(value) > 2_048 || !utf8.ValidString(value) {
		return false
	}
	parsed, err := url.Parse(value)
	return err == nil && parsed.Scheme == "https" && parsed.Hostname() == "checkout.stripe.com" && parsed.User == nil && parsed.Fragment == ""
}

func rejectedEvent(reason RejectionReason) EventPlan {
	return EventPlan{Kind: EventRejected, Reason: reason}
}
