package billing

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

func TestCancellationPlansSeparatePeriodEndAndImmediateEffects(t *testing.T) {
	record := cancellationRecord(t)
	command := cancellationCommand(t)

	periodEnd := PlanPeriodEndSubscriptionCancellation(command, &record)
	if periodEnd.Kind != CancellationPlanRequestProvider || periodEnd.Command.Effect != ProviderCancellationPeriodEnd ||
		periodEnd.Command.Provider != "stripe" || periodEnd.Command.ProviderSubscriptionReference != "sub_notes" ||
		periodEnd.Command.IdempotencyKey != command.IdempotencyKey || periodEnd.Command.RequestedAt != command.RequestedAt {
		t.Fatalf("period-end plan = %#v", periodEnd)
	}
	immediate := PlanImmediateSubscriptionCancellation(command, &record)
	if immediate.Kind != CancellationPlanRequestProvider || immediate.Command.Effect != ProviderCancellationImmediate {
		t.Fatalf("immediate plan = %#v", immediate)
	}

	scheduled := record
	scheduled.CancelAt = timestamp(4_000)
	scheduled.CancellationUpdatedAt = timestamp(1_050)
	periodEnd = PlanPeriodEndSubscriptionCancellation(command, &scheduled)
	if periodEnd.Kind != CancellationPlanComplete || periodEnd.Result.Kind != SubscriptionCancellationConfirmed ||
		periodEnd.Result.Outcome != SubscriptionCancellationScheduled || periodEnd.Result.ConfirmedAt != 1_050 ||
		periodEnd.Result.AccessEndsAt != 4_000 {
		t.Fatalf("scheduled plan = %#v", periodEnd)
	}
	immediate = PlanImmediateSubscriptionCancellation(command, &scheduled)
	if immediate.Kind != CancellationPlanRequestProvider || immediate.Command.Effect != ProviderCancellationImmediate {
		t.Fatalf("scheduled immediate plan = %#v", immediate)
	}

	cancelled := record
	cancelled.Lifecycle = Lifecycle{Kind: LifecycleCancelled, CancelledAt: 1_000}
	cancelled.CancellationUpdatedAt = timestamp(1_050)
	periodEnd = PlanPeriodEndSubscriptionCancellation(command, &cancelled)
	if periodEnd.Kind != CancellationPlanComplete || periodEnd.Result.Kind != SubscriptionCancellationConfirmed ||
		periodEnd.Result.Outcome != SubscriptionAlreadyCancelled || periodEnd.Result.ConfirmedAt != 1_050 ||
		periodEnd.Result.AccessEndsAt != 1_000 {
		t.Fatalf("cancelled plan = %#v", periodEnd)
	}
}

func TestCancellationPlansFailClosed(t *testing.T) {
	command := cancellationCommand(t)
	if plan := PlanPeriodEndSubscriptionCancellation(command, nil); plan.Result.Reason != CancellationSubscriptionNotFound {
		t.Fatalf("missing = %#v", plan)
	}
	record := cancellationRecord(t)
	other, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000102")
	if err != nil {
		t.Fatal(err)
	}
	record.AccountID = other
	if plan := PlanPeriodEndSubscriptionCancellation(command, &record); plan.Result.Reason != CancellationOwnerMismatch {
		t.Fatalf("owner mismatch = %#v", plan)
	}
	record = checkoutRecord(t)
	if plan := PlanPeriodEndSubscriptionCancellation(command, &record); plan.Result.Reason != CancellationProviderNotLinked {
		t.Fatalf("unlinked = %#v", plan)
	}
	command.RequestedAt = -1
	if plan := PlanPeriodEndSubscriptionCancellation(command, &record); plan.Result.Reason != CancellationInvalidCommand {
		t.Fatalf("invalid = %#v", plan)
	}
	command = cancellationCommand(t)
	record = cancellationRecord(t)
	record.Lifecycle = Lifecycle{Kind: LifecycleCancelled, CancelledAt: command.RequestedAt + 1}
	if plan := PlanImmediateSubscriptionCancellation(command, &record); plan.Result.Reason != CancellationInvalidSubscriptionState {
		t.Fatalf("future cancellation = %#v", plan)
	}
}

func TestPeriodEndCancellationEvaluationAcceptsReplayAndRejectsCrossEffect(t *testing.T) {
	command := providerCancellationCommand(ProviderCancellationPeriodEnd)
	observation := providerCancellationObservation(command, ProviderCancellationScheduled, 1_000, 2_000)
	result := EvaluatePeriodEndProviderCancellation(command, observation)
	if result.Kind != SubscriptionCancellationConfirmed || result.Outcome != SubscriptionCancellationScheduled ||
		result.ConfirmedAt != 1_000 || result.AccessEndsAt != 2_000 {
		t.Fatalf("replayed schedule = %#v", result)
	}

	observation.AccessEndsAt = command.RequestedAt - 1
	if result = EvaluatePeriodEndProviderCancellation(command, observation); result.Reason != CancellationProviderResultMismatch {
		t.Fatalf("expired schedule = %#v", result)
	}
	observation = providerCancellationObservation(command, ProviderCancellationCancelled, 1_200, 1_200)
	if result = EvaluatePeriodEndProviderCancellation(command, observation); result.Reason != CancellationProviderResultMismatch {
		t.Fatalf("cross effect = %#v", result)
	}
	observation.Kind = ProviderCancellationAlreadyCancelled
	if result = EvaluatePeriodEndProviderCancellation(command, observation); result.Kind != SubscriptionCancellationConfirmed ||
		result.Outcome != SubscriptionAlreadyCancelled {
		t.Fatalf("already cancelled = %#v", result)
	}
}

func TestImmediateCancellationEvaluationAcceptsReplayAndRejectsScheduledResult(t *testing.T) {
	command := providerCancellationCommand(ProviderCancellationImmediate)
	observation := providerCancellationObservation(command, ProviderCancellationCancelled, 1_000, 1_000)
	result := EvaluateImmediateProviderCancellation(command, observation)
	if result.Kind != SubscriptionCancellationConfirmed || result.Outcome != SubscriptionCancelled ||
		result.ConfirmedAt != 1_000 || result.AccessEndsAt != 1_000 {
		t.Fatalf("replayed cancellation = %#v", result)
	}

	observation.AccessEndsAt = observation.ObservedAt + 1
	if result = EvaluateImmediateProviderCancellation(command, observation); result.Reason != CancellationProviderResultMismatch {
		t.Fatalf("future access end = %#v", result)
	}
	observation = providerCancellationObservation(command, ProviderCancellationScheduled, 1_200, 2_000)
	if result = EvaluateImmediateProviderCancellation(command, observation); result.Reason != CancellationProviderResultMismatch {
		t.Fatalf("cross effect = %#v", result)
	}
}

func TestCancellationEvaluationRejectsIdentityMismatchAndClassifiesFailures(t *testing.T) {
	command := providerCancellationCommand(ProviderCancellationPeriodEnd)
	observation := providerCancellationObservation(command, ProviderCancellationScheduled, 1_200, 2_000)
	observation.IdempotencyKey = "different"
	if result := EvaluatePeriodEndProviderCancellation(command, observation); result.Reason != CancellationProviderResultMismatch {
		t.Fatalf("identity mismatch = %#v", result)
	}

	observation = providerCancellationObservation(command, ProviderCancellationRetryableFailure, 1_200, 0)
	if result := EvaluatePeriodEndProviderCancellation(command, observation); result.Reason != CancellationProviderUnavailable {
		t.Fatalf("retryable = %#v", result)
	}
	observation.Kind = ProviderCancellationTerminalFailure
	if result := EvaluatePeriodEndProviderCancellation(command, observation); result.Kind != SubscriptionCancellationTerminalFailure ||
		result.Reason != CancellationProviderTerminal {
		t.Fatalf("terminal = %#v", result)
	}
	observation.AccessEndsAt = 1
	if ValidProviderCancellationObservation(observation) {
		t.Fatalf("failure observation accepted access end: %#v", observation)
	}
}

func TestCancellationServiceReplaysLostProviderResponsesWithoutDuplicateEffects(t *testing.T) {
	tests := []struct {
		name        string
		effect      ProviderCancellationEffect
		invoke      func(*CancellationService, context.Context, SubscriptionCancellationCommand) (SubscriptionCancellationResult, error)
		wantOutcome SubscriptionCancellationOutcome
	}{
		{
			name: "period end", effect: ProviderCancellationPeriodEnd,
			invoke:      (*CancellationService).ScheduleSubscriptionCancellation,
			wantOutcome: SubscriptionCancellationScheduled,
		},
		{
			name: "immediate", effect: ProviderCancellationImmediate,
			invoke:      (*CancellationService).CancelSubscriptionImmediately,
			wantOutcome: SubscriptionAlreadyCancelled,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			repository := &cancellationRepository{record: cancellationRecord(t)}
			provider := &cancellationProvider{loseFirstResponse: true, confirmed: make(map[string]ProviderCancellationObservation)}
			service, err := NewCancellationService(repository, provider)
			if err != nil {
				t.Fatal(err)
			}
			command := cancellationCommand(t)
			first, err := test.invoke(service, context.Background(), command)
			if err != nil || first.Kind != SubscriptionCancellationRetryableFailure || first.Reason != CancellationProviderUnavailable {
				t.Fatalf("first = %#v, %v", first, err)
			}
			second, err := test.invoke(service, context.Background(), command)
			if err != nil || second.Kind != SubscriptionCancellationConfirmed || second.Outcome != test.wantOutcome {
				t.Fatalf("second = %#v, %v", second, err)
			}
			if provider.effects != 1 || len(provider.commands) != 2 || provider.commands[0] != provider.commands[1] ||
				provider.commands[0].Effect != test.effect {
				t.Fatalf("provider = effects %d commands %#v", provider.effects, provider.commands)
			}
			if repository.record.Lifecycle.Kind != LifecycleTrialing {
				t.Fatalf("billing projection was mutated: %#v", repository.record)
			}
		})
	}
}

func TestCancellationServiceRedactsProviderAndRepositoryFailures(t *testing.T) {
	provider := &cancellationProvider{err: errors.New("provider secret detail")}
	service, err := NewCancellationService(&cancellationRepository{record: cancellationRecord(t)}, provider)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.ScheduleSubscriptionCancellation(context.Background(), cancellationCommand(t))
	if err != nil || result.Reason != CancellationProviderUnavailable {
		t.Fatalf("provider result = %#v, %v", result, err)
	}

	repositoryError := errors.New("database secret detail")
	service, err = NewCancellationService(&cancellationRepository{err: repositoryError}, provider)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.ScheduleSubscriptionCancellation(context.Background(), cancellationCommand(t)); !errors.Is(err, repositoryError) {
		t.Fatalf("repository error = %v", err)
	}
}

type cancellationRepository struct {
	record SubscriptionRecord
	err    error
}

func (repository *cancellationRepository) FindByOwner(context.Context, OwnerScope) (*SubscriptionRecord, error) {
	if repository.err != nil {
		return nil, repository.err
	}
	record := repository.record
	return &record, nil
}

type cancellationProvider struct {
	commands          []ProviderCancellationCommand
	confirmed         map[string]ProviderCancellationObservation
	loseFirstResponse bool
	effects           int
	err               error
}

func (provider *cancellationProvider) CancelSubscription(
	_ context.Context,
	command ProviderCancellationCommand,
) (ProviderCancellationObservation, error) {
	provider.commands = append(provider.commands, command)
	if provider.err != nil {
		return ProviderCancellationObservation{}, provider.err
	}
	key := string(command.Effect) + ":" + string(command.IdempotencyKey)
	if replay, ok := provider.confirmed[key]; ok {
		if replay.Kind == ProviderCancellationCancelled {
			replay.Kind = ProviderCancellationAlreadyCancelled
		}
		return replay, nil
	}
	kind := ProviderCancellationScheduled
	accessEndsAt := command.RequestedAt + 1_000
	if command.Effect == ProviderCancellationImmediate {
		kind = ProviderCancellationCancelled
		accessEndsAt = command.RequestedAt
	}
	observation := providerCancellationObservation(command, kind, command.RequestedAt, accessEndsAt)
	provider.confirmed[key] = observation
	provider.effects++
	if provider.loseFirstResponse {
		provider.loseFirstResponse = false
		return ProviderCancellationObservation{}, errors.New("lost response")
	}
	return observation, nil
}

func providerCancellationCommand(effect ProviderCancellationEffect) ProviderCancellationCommand {
	return ProviderCancellationCommand{
		Provider: "stripe", ProviderSubscriptionReference: "sub_notes",
		IdempotencyKey: "01991f20-61d2-7000-8000-000000000801", RequestedAt: 1_100,
		Effect: effect,
	}
}

func providerCancellationObservation(
	command ProviderCancellationCommand,
	kind ProviderCancellationKind,
	observedAt int64,
	accessEndsAt int64,
) ProviderCancellationObservation {
	return ProviderCancellationObservation{
		Kind: kind, Provider: command.Provider,
		ProviderSubscriptionReference: command.ProviderSubscriptionReference,
		IdempotencyKey:                command.IdempotencyKey, ObservedAt: observedAt, AccessEndsAt: accessEndsAt,
	}
}

func cancellationRecord(t *testing.T) SubscriptionRecord {
	t.Helper()
	return requireApplied(t, checkoutRecord(t), providerFact(FactTrialStarted, 2_000))
}

func cancellationCommand(t *testing.T) SubscriptionCancellationCommand {
	t.Helper()
	key, err := ParseCancellationIdempotencyKey("01991f20-61d2-7000-8000-000000000801")
	if err != nil {
		t.Fatal(err)
	}
	return SubscriptionCancellationCommand{Scope: ownerScope(t), IdempotencyKey: key, RequestedAt: 1_100}
}

func timestamp(value int64) *int64 {
	return &value
}
