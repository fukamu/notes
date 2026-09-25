package accountdeletion

import (
	"context"

	"github.com/fukamu/notes/backend/internal/billing"
)

type BillingCancellationEffect struct {
	cancellation billing.SubscriptionCancellationPort
}

var _ ImmediateCancellationPort = (*BillingCancellationEffect)(nil)

func NewBillingCancellationEffect(
	cancellation billing.SubscriptionCancellationPort,
) (*BillingCancellationEffect, error) {
	if cancellation == nil {
		return nil, ErrInvalidServiceConfiguration
	}
	return &BillingCancellationEffect{cancellation: cancellation}, nil
}

func (effect *BillingCancellationEffect) CancelSubscriptionImmediately(
	ctx context.Context,
	input StepEffectInput,
) (StepEffectResult, error) {
	if effect == nil || effect.cancellation == nil || !ValidStepEffectInput(input, StepCancelSubscription) {
		return terminalEffect("subscription-cancellation-terminal"), nil
	}
	idempotencyKey, err := billing.ParseCancellationIdempotencyKey(string(input.OperationID))
	if err != nil {
		return terminalEffect("subscription-cancellation-terminal"), nil
	}
	result, err := effect.cancellation.CancelSubscription(ctx, billing.SubscriptionCancellationCommand{
		Scope: billing.OwnerScope{
			AccountID: input.Scope.AccountID,
			VaultID:   input.Scope.VaultID,
		},
		IdempotencyKey: idempotencyKey,
		RequestedAt:    input.RequestedAt,
	})
	if err != nil {
		return retryableEffect("subscription-cancellation-unavailable"), nil
	}
	switch result.Kind {
	case billing.SubscriptionCancellationConfirmed:
		return StepEffectResult{Kind: EffectSucceeded}, nil
	case billing.SubscriptionCancellationRetryableFailure:
		if result.Reason == billing.CancellationProviderUnavailable {
			return retryableEffect("subscription-cancellation-unavailable"), nil
		}
		return retryableEffect("subscription-cancellation-incomplete"), nil
	case billing.SubscriptionCancellationTerminalFailure:
		if result.Reason == billing.CancellationOwnerMismatch {
			return terminalEffect("subscription-owner-mismatch"), nil
		}
		return terminalEffect("subscription-cancellation-terminal"), nil
	default:
		return retryableEffect("subscription-cancellation-incomplete"), nil
	}
}

func retryableEffect(code string) StepEffectResult {
	failureCode, _ := ParseFailureCode(code)
	return StepEffectResult{Kind: EffectRetryableFailure, FailureCode: failureCode}
}

func terminalEffect(code string) StepEffectResult {
	failureCode, _ := ParseFailureCode(code)
	return StepEffectResult{Kind: EffectTerminalFailure, FailureCode: failureCode}
}
