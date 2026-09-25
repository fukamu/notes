package accountdeletion

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
)

func TestBillingCancellationEffectUsesStableSagaIdentityAndTiming(t *testing.T) {
	cancellation := &billingCancellationStub{
		result: billing.SubscriptionCancellationResult{
			Kind:        billing.SubscriptionCancellationConfirmed,
			Outcome:     billing.SubscriptionCancelled,
			ConfirmedAt: 1_150,
		},
	}
	effect, err := NewBillingCancellationEffect(cancellation)
	if err != nil {
		t.Fatal(err)
	}
	input := validBillingEffectInput(t)
	result, err := effect.CancelSubscriptionImmediately(context.Background(), input)
	if err != nil || result.Kind != EffectSucceeded || len(cancellation.commands) != 1 {
		t.Fatalf("result = %#v commands=%#v err=%v", result, cancellation.commands, err)
	}
	command := cancellation.commands[0]
	if command.Scope.AccountID != input.Scope.AccountID || command.Scope.VaultID != input.Scope.VaultID ||
		string(command.IdempotencyKey) != string(input.OperationID) || command.RequestedAt != input.RequestedAt {
		t.Fatalf("command = %#v", command)
	}
}

func TestBillingCancellationEffectMapsOnlyFixedFailureCodes(t *testing.T) {
	tests := []struct {
		name   string
		result billing.SubscriptionCancellationResult
		err    error
		kind   StepEffectResultKind
		code   FailureCode
	}{
		{
			name: "provider unavailable", kind: EffectRetryableFailure,
			result: billing.SubscriptionCancellationResult{
				Kind:   billing.SubscriptionCancellationRetryableFailure,
				Reason: billing.CancellationProviderUnavailable,
			},
			code: "subscription-cancellation-unavailable",
		},
		{
			name: "mismatched result", kind: EffectRetryableFailure,
			result: billing.SubscriptionCancellationResult{
				Kind:   billing.SubscriptionCancellationRetryableFailure,
				Reason: billing.CancellationProviderResultMismatch,
			},
			code: "subscription-cancellation-incomplete",
		},
		{
			name: "owner mismatch", kind: EffectTerminalFailure,
			result: billing.SubscriptionCancellationResult{
				Kind:   billing.SubscriptionCancellationTerminalFailure,
				Reason: billing.CancellationOwnerMismatch,
			},
			code: "subscription-owner-mismatch",
		},
		{
			name: "terminal provider", kind: EffectTerminalFailure,
			result: billing.SubscriptionCancellationResult{
				Kind:   billing.SubscriptionCancellationTerminalFailure,
				Reason: billing.CancellationProviderTerminal,
			},
			code: "subscription-cancellation-terminal",
		},
		{
			name: "dependency error", kind: EffectRetryableFailure,
			err: errors.New("provider secret detail"), code: "subscription-cancellation-unavailable",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			cancellation := &billingCancellationStub{result: test.result, err: test.err}
			effect, err := NewBillingCancellationEffect(cancellation)
			if err != nil {
				t.Fatal(err)
			}
			result, err := effect.CancelSubscriptionImmediately(context.Background(), validBillingEffectInput(t))
			if err != nil || result.Kind != test.kind || result.FailureCode != test.code {
				t.Fatalf("result = %#v, %v", result, err)
			}
		})
	}
}

func TestBillingCancellationEffectRejectsWrongStepBeforeDependency(t *testing.T) {
	cancellation := &billingCancellationStub{}
	effect, err := NewBillingCancellationEffect(cancellation)
	if err != nil {
		t.Fatal(err)
	}
	input := validBillingEffectInput(t)
	input.Step = StepDeleteVaultData
	result, err := effect.CancelSubscriptionImmediately(context.Background(), input)
	if err != nil || result.Kind != EffectTerminalFailure || result.FailureCode != "subscription-cancellation-terminal" || len(cancellation.commands) != 0 {
		t.Fatalf("result = %#v calls=%d err=%v", result, len(cancellation.commands), err)
	}
}

type billingCancellationStub struct {
	commands []billing.SubscriptionCancellationCommand
	result   billing.SubscriptionCancellationResult
	err      error
}

func (stub *billingCancellationStub) CancelSubscription(
	_ context.Context,
	command billing.SubscriptionCancellationCommand,
) (billing.SubscriptionCancellationResult, error) {
	stub.commands = append(stub.commands, command)
	return stub.result, stub.err
}

func validBillingEffectInput(t *testing.T) StepEffectInput {
	t.Helper()
	operationID, err := ParseOperationID("01991f20-61d2-7000-8000-000000002801")
	if err != nil {
		t.Fatal(err)
	}
	return StepEffectInput{
		Scope: mustApplicationScope(t), OperationID: operationID,
		Step: StepCancelSubscription, Attempt: 1, RequestedAt: 1_100, ExecutedAt: 1_200,
	}
}
