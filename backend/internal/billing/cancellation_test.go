package billing

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

func TestPlanSubscriptionCancellationUsesStoredMappingAndLocalCancellation(t *testing.T) {
	record := cancellationRecord(t)
	command := cancellationCommand(t)
	plan := PlanSubscriptionCancellation(command, &record)
	if plan.Kind != CancellationPlanRequestProvider || plan.Command.Provider != "stripe" ||
		plan.Command.ProviderSubscriptionReference != "sub_notes" ||
		plan.Command.IdempotencyKey != command.IdempotencyKey || plan.Command.RequestedAt != command.RequestedAt {
		t.Fatalf("plan = %#v", plan)
	}

	cancelled := record
	cancelled.Lifecycle = Lifecycle{Kind: LifecycleCancelled, CancelledAt: 2_500}
	plan = PlanSubscriptionCancellation(command, &cancelled)
	if plan.Kind != CancellationPlanComplete || plan.Result.Kind != SubscriptionCancellationConfirmed ||
		plan.Result.Outcome != SubscriptionAlreadyCancelled || plan.Result.ConfirmedAt != 2_500 {
		t.Fatalf("cancelled plan = %#v", plan)
	}
}

func TestPlanSubscriptionCancellationFailsClosed(t *testing.T) {
	command := cancellationCommand(t)
	if plan := PlanSubscriptionCancellation(command, nil); plan.Result.Reason != CancellationSubscriptionNotFound {
		t.Fatalf("missing = %#v", plan)
	}
	record := cancellationRecord(t)
	other, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000102")
	if err != nil {
		t.Fatal(err)
	}
	record.AccountID = other
	if plan := PlanSubscriptionCancellation(command, &record); plan.Result.Reason != CancellationOwnerMismatch {
		t.Fatalf("owner mismatch = %#v", plan)
	}
	record = checkoutRecord(t)
	if plan := PlanSubscriptionCancellation(command, &record); plan.Result.Reason != CancellationProviderNotLinked {
		t.Fatalf("unlinked = %#v", plan)
	}
	command.RequestedAt = -1
	if plan := PlanSubscriptionCancellation(command, &record); plan.Result.Reason != CancellationInvalidCommand {
		t.Fatalf("invalid = %#v", plan)
	}
}

func TestEvaluateProviderCancellationRejectsMismatchesAndClassifiesResults(t *testing.T) {
	command := ProviderCancellationCommand{
		Provider: "stripe", ProviderSubscriptionReference: "sub_notes",
		IdempotencyKey: "01991f20-61d2-7000-8000-000000000801", RequestedAt: 1_100,
	}
	observation := ProviderCancellationObservation{
		Kind: ProviderCancellationCancelled, Provider: command.Provider,
		ProviderSubscriptionReference: command.ProviderSubscriptionReference,
		IdempotencyKey:                command.IdempotencyKey, ObservedAt: 1_200,
	}
	if result := EvaluateProviderCancellation(command, observation); result.Kind != SubscriptionCancellationConfirmed || result.Outcome != SubscriptionCancelled {
		t.Fatalf("confirmed = %#v", result)
	}
	observation.ObservedAt = 1_099
	if result := EvaluateProviderCancellation(command, observation); result.Reason != CancellationProviderResultMismatch {
		t.Fatalf("out of order = %#v", result)
	}
	observation.ObservedAt = 1_200
	observation.Kind = ProviderCancellationRetryableFailure
	if result := EvaluateProviderCancellation(command, observation); result.Reason != CancellationProviderUnavailable {
		t.Fatalf("retryable = %#v", result)
	}
	observation.Kind = ProviderCancellationTerminalFailure
	if result := EvaluateProviderCancellation(command, observation); result.Kind != SubscriptionCancellationTerminalFailure || result.Reason != CancellationProviderTerminal {
		t.Fatalf("terminal = %#v", result)
	}
}

func TestCancellationServiceReplaysLostProviderResponseWithStableCommand(t *testing.T) {
	repository := &cancellationRepository{record: cancellationRecord(t)}
	provider := &cancellationProvider{loseFirstResponse: true, confirmed: make(map[CancellationIdempotencyKey]ProviderCancellationObservation)}
	service, err := NewCancellationService(repository, provider)
	if err != nil {
		t.Fatal(err)
	}
	command := cancellationCommand(t)
	first, err := service.CancelSubscription(context.Background(), command)
	if err != nil || first.Kind != SubscriptionCancellationRetryableFailure || first.Reason != CancellationProviderUnavailable {
		t.Fatalf("first = %#v, %v", first, err)
	}
	second, err := service.CancelSubscription(context.Background(), command)
	if err != nil || second.Kind != SubscriptionCancellationConfirmed || second.Outcome != SubscriptionAlreadyCancelled {
		t.Fatalf("second = %#v, %v", second, err)
	}
	if provider.effects != 1 || len(provider.commands) != 2 || provider.commands[0] != provider.commands[1] {
		t.Fatalf("provider = effects %d commands %#v", provider.effects, provider.commands)
	}
	if repository.record.Lifecycle.Kind != LifecycleTrialing {
		t.Fatalf("billing projection was mutated: %#v", repository.record)
	}
}

func TestCancellationServiceRedactsProviderAndRepositoryFailures(t *testing.T) {
	provider := &cancellationProvider{err: errors.New("provider secret detail")}
	service, err := NewCancellationService(&cancellationRepository{record: cancellationRecord(t)}, provider)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.CancelSubscription(context.Background(), cancellationCommand(t))
	if err != nil || result.Reason != CancellationProviderUnavailable {
		t.Fatalf("provider result = %#v, %v", result, err)
	}

	repositoryError := errors.New("database secret detail")
	service, err = NewCancellationService(&cancellationRepository{err: repositoryError}, provider)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := service.CancelSubscription(context.Background(), cancellationCommand(t)); !errors.Is(err, repositoryError) {
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
	confirmed         map[CancellationIdempotencyKey]ProviderCancellationObservation
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
	if replay, ok := provider.confirmed[command.IdempotencyKey]; ok {
		replay.Kind = ProviderCancellationAlreadyCancelled
		return replay, nil
	}
	observation := ProviderCancellationObservation{
		Kind: ProviderCancellationCancelled, Provider: command.Provider,
		ProviderSubscriptionReference: command.ProviderSubscriptionReference,
		IdempotencyKey:                command.IdempotencyKey, ObservedAt: command.RequestedAt,
	}
	provider.confirmed[command.IdempotencyKey] = observation
	provider.effects++
	if provider.loseFirstResponse {
		provider.loseFirstResponse = false
		return ProviderCancellationObservation{}, errors.New("lost response")
	}
	return observation, nil
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
