package stripebilling

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrInvalidServiceConfiguration = errors.New("invalid Stripe billing service configuration")

type Service struct {
	configuration Configuration
	billing       BillingPort
	provider      ProviderPort
	verifier      WebhookVerifierPort
}

func NewService(configuration Configuration, billingPort BillingPort, provider ProviderPort, verifier WebhookVerifierPort) (*Service, error) {
	if !configuration.Valid() || billingPort == nil || provider == nil || verifier == nil {
		return nil, ErrInvalidServiceConfiguration
	}
	return &Service{configuration: configuration, billing: billingPort, provider: provider, verifier: verifier}, nil
}

func (service *Service) BeginHostedCheckout(
	ctx context.Context,
	vaultContext identity.VaultContext,
	command HostedCheckoutCommand,
) HostedCheckoutResult {
	planned, err := PlanCheckout(service.configuration, command)
	if err != nil {
		return rejectedCheckout(ReasonInvalidInput)
	}
	began, err := service.billing.BeginCheckout(ctx, vaultContext, billing.BeginCheckoutCommand{
		SubscriptionID: command.SubscriptionID, CheckoutID: command.CheckoutIntentID,
		Provider: Provider, CreatedAt: command.CreatedAt,
	})
	if err != nil {
		return rejectedCheckout(ReasonBillingRejected)
	}
	if began.Kind == billing.ResultRejected {
		if began.Reason == billing.ResultInvalidTransition {
			return rejectedCheckout(ReasonInvalidInput)
		}
		return rejectedCheckout(ReasonBillingRejected)
	}
	providerResponse, err := service.provider.CreateCheckoutSession(ctx, planned)
	if err != nil {
		return rejectedCheckout(ReasonProviderUnavailable)
	}
	response, reason := DecodeCheckoutResponse(providerResponse, command, service.configuration.Mode)
	if reason != "" {
		return rejectedCheckout(reason)
	}
	opened, err := service.billing.RecordCheckoutOpened(ctx, vaultContext, billing.RecordCheckoutOpenedCommand{
		SubscriptionID: command.SubscriptionID, CheckoutIntentID: command.CheckoutIntentID,
		ProviderCheckoutReference: response.ProviderCheckoutReference, OpenedAt: command.CreatedAt,
	})
	if err != nil {
		return rejectedCheckout(ReasonBillingRejected)
	}
	if opened.Kind == billing.ResultRejected {
		if opened.Reason == billing.ResultIdentifierConflict {
			return rejectedCheckout(ReasonProviderMappingMismatch)
		}
		return rejectedCheckout(ReasonBillingRejected)
	}
	return HostedCheckoutResult{Kind: HostedCheckoutRedirect, CheckoutURL: response.CheckoutURL, ProviderCheckoutReference: response.ProviderCheckoutReference}
}

func (service *Service) IngestWebhook(ctx context.Context, request WebhookRequest) WebhookResult {
	if len(request.RawBody) == 0 || len(request.RawBody) > MaxWebhookBytes || !validMillis(request.ReceivedAt) {
		return rejectedWebhook(ReasonMalformedEvent)
	}
	verified := service.verifier.Verify(request)
	if !verified.Verified {
		return rejectedWebhook(ReasonInvalidSignature)
	}
	plan := DecodeEventPlan(verified.RawBody, service.configuration.Mode, service.configuration.APIVersion, request.ReceivedAt)
	switch plan.Kind {
	case EventUnsupported:
		return WebhookResult{Kind: WebhookIgnored}
	case EventRejected:
		return rejectedWebhook(plan.Reason)
	case EventFact:
		if plan.Fact == nil {
			return rejectedWebhook(ReasonMalformedEvent)
		}
		result, err := service.billing.IngestVerifiedProviderFact(ctx, *plan.Fact)
		return billingResult(result, err)
	case EventSnapshot:
		if plan.Snapshot == nil {
			return rejectedWebhook(ReasonMalformedEvent)
		}
		return service.retrieveAndReconcile(ctx, *plan.Snapshot)
	default:
		return rejectedWebhook(ReasonMalformedEvent)
	}
}

func (service *Service) ReconcileSubscription(ctx context.Context, command ReconciliationCommand) WebhookResult {
	return service.retrieveAndReconcile(ctx, SnapshotPlan{
		SnapshotID: command.SnapshotID, SubscriptionID: command.SubscriptionID,
		ProviderSubscriptionReference: command.ProviderSubscriptionReference,
		ObservedAt:                    command.ObservedAt, RecordedAt: command.RecordedAt,
	})
}

func (service *Service) retrieveAndReconcile(ctx context.Context, plan SnapshotPlan) WebhookResult {
	input, err := service.provider.RetrieveSubscriptionSnapshot(ctx, plan.ProviderSubscriptionReference)
	if err != nil {
		return rejectedWebhook(ReasonProviderUnavailable)
	}
	snapshot, ok := DecodeReconciliationSnapshot(input, plan)
	if !ok {
		return rejectedWebhook(ReasonMalformedEvent)
	}
	result, err := service.billing.ReconcileVerifiedSnapshot(ctx, snapshot)
	return billingResult(result, err)
}

func billingResult(result billing.CommandResult, err error) WebhookResult {
	if err != nil || result.Kind == billing.ResultRejected {
		return rejectedWebhook(ReasonBillingRejected)
	}
	return WebhookResult{Kind: WebhookAccepted, Outcome: result.Kind}
}

func rejectedCheckout(reason RejectionReason) HostedCheckoutResult {
	return HostedCheckoutResult{Kind: HostedCheckoutRejected, Reason: reason}
}

func rejectedWebhook(reason RejectionReason) WebhookResult {
	return WebhookResult{Kind: WebhookRejected, Reason: reason}
}
