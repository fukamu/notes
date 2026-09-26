package billing

import (
	"context"
	"errors"
	"regexp"
)

var (
	ErrInvalidCancellationConfiguration = errors.New("invalid subscription cancellation configuration")
	cancellationIdempotencyPattern      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9:_-]{0,254}$`)
)

type CancellationIdempotencyKey string

func ParseCancellationIdempotencyKey(value string) (CancellationIdempotencyKey, error) {
	if !cancellationIdempotencyPattern.MatchString(value) {
		return "", ErrInvalidIdentifier
	}
	return CancellationIdempotencyKey(value), nil
}

type SubscriptionCancellationCommand struct {
	Scope          OwnerScope
	IdempotencyKey CancellationIdempotencyKey
	RequestedAt    int64
}

type ProviderCancellationEffect string

const (
	ProviderCancellationPeriodEnd ProviderCancellationEffect = "period-end"
	ProviderCancellationImmediate ProviderCancellationEffect = "immediate"
)

type ProviderCancellationCommand struct {
	Provider                      Provider
	ProviderSubscriptionReference ProviderSubscriptionReference
	IdempotencyKey                CancellationIdempotencyKey
	RequestedAt                   int64
	Effect                        ProviderCancellationEffect
}

type ProviderCancellationKind string

const (
	ProviderCancellationScheduled        ProviderCancellationKind = "scheduled"
	ProviderCancellationCancelled        ProviderCancellationKind = "cancelled"
	ProviderCancellationAlreadyCancelled ProviderCancellationKind = "already-cancelled"
	ProviderCancellationRetryableFailure ProviderCancellationKind = "retryable-failure"
	ProviderCancellationTerminalFailure  ProviderCancellationKind = "terminal-failure"
)

type ProviderCancellationObservation struct {
	Kind                          ProviderCancellationKind
	Provider                      Provider
	ProviderSubscriptionReference ProviderSubscriptionReference
	IdempotencyKey                CancellationIdempotencyKey
	ObservedAt                    int64
	AccessEndsAt                  int64
}

type SubscriptionCancellationResultKind string
type SubscriptionCancellationOutcome string
type SubscriptionCancellationReason string

const (
	SubscriptionCancellationConfirmed        SubscriptionCancellationResultKind = "confirmed"
	SubscriptionCancellationRetryableFailure SubscriptionCancellationResultKind = "retryable-failure"
	SubscriptionCancellationTerminalFailure  SubscriptionCancellationResultKind = "terminal-failure"

	SubscriptionCancellationScheduled SubscriptionCancellationOutcome = "scheduled"
	SubscriptionCancelled             SubscriptionCancellationOutcome = "cancelled"
	SubscriptionAlreadyCancelled      SubscriptionCancellationOutcome = "already-cancelled"

	CancellationInvalidCommand            SubscriptionCancellationReason = "invalid-command"
	CancellationInvalidSubscriptionState  SubscriptionCancellationReason = "invalid-subscription-state"
	CancellationOwnerMismatch             SubscriptionCancellationReason = "owner-mismatch"
	CancellationSubscriptionNotFound      SubscriptionCancellationReason = "subscription-not-found"
	CancellationProviderNotLinked         SubscriptionCancellationReason = "provider-not-linked"
	CancellationProviderUnavailable       SubscriptionCancellationReason = "provider-unavailable"
	CancellationMalformedProviderResponse SubscriptionCancellationReason = "malformed-provider-response"
	CancellationProviderResultMismatch    SubscriptionCancellationReason = "provider-result-mismatch"
	CancellationProviderTerminal          SubscriptionCancellationReason = "provider-terminal"
)

type SubscriptionCancellationResult struct {
	Kind         SubscriptionCancellationResultKind
	Outcome      SubscriptionCancellationOutcome
	Reason       SubscriptionCancellationReason
	ConfirmedAt  int64
	AccessEndsAt int64
}

type CancellationPlanKind string

const (
	CancellationPlanRequestProvider CancellationPlanKind = "request-provider"
	CancellationPlanComplete        CancellationPlanKind = "complete"
)

type CancellationPlan struct {
	Kind    CancellationPlanKind
	Command ProviderCancellationCommand
	Result  SubscriptionCancellationResult
}

type SubscriptionCancellationLookup interface {
	FindByOwner(context.Context, OwnerScope) (*SubscriptionRecord, error)
}

type SubscriptionCancellationProviderPort interface {
	CancelSubscription(context.Context, ProviderCancellationCommand) (ProviderCancellationObservation, error)
}

type PeriodEndSubscriptionCancellationPort interface {
	ScheduleSubscriptionCancellation(context.Context, SubscriptionCancellationCommand) (SubscriptionCancellationResult, error)
}

type ImmediateSubscriptionCancellationPort interface {
	CancelSubscriptionImmediately(context.Context, SubscriptionCancellationCommand) (SubscriptionCancellationResult, error)
}

type SubscriptionCancellationPort interface {
	PeriodEndSubscriptionCancellationPort
	ImmediateSubscriptionCancellationPort
}

type CancellationService struct {
	repository SubscriptionCancellationLookup
	provider   SubscriptionCancellationProviderPort
}

var _ SubscriptionCancellationPort = (*CancellationService)(nil)

func NewCancellationService(
	repository SubscriptionCancellationLookup,
	provider SubscriptionCancellationProviderPort,
) (*CancellationService, error) {
	if repository == nil || provider == nil {
		return nil, ErrInvalidCancellationConfiguration
	}
	return &CancellationService{repository: repository, provider: provider}, nil
}

func PlanPeriodEndSubscriptionCancellation(
	command SubscriptionCancellationCommand,
	current *SubscriptionRecord,
) CancellationPlan {
	prerequisite := cancellationPrerequisite(command, current)
	if prerequisite.Kind == CancellationPlanComplete {
		return prerequisite
	}
	if current.CancelAt != nil && *current.CancelAt >= command.RequestedAt {
		confirmedAt := current.UpdatedAt
		if current.CancellationUpdatedAt != nil {
			confirmedAt = *current.CancellationUpdatedAt
		}
		return CancellationPlan{
			Kind: CancellationPlanComplete,
			Result: SubscriptionCancellationResult{
				Kind: SubscriptionCancellationConfirmed, Outcome: SubscriptionCancellationScheduled,
				ConfirmedAt: confirmedAt, AccessEndsAt: *current.CancelAt,
			},
		}
	}
	prerequisite.Command.Effect = ProviderCancellationPeriodEnd
	return prerequisite
}

func PlanImmediateSubscriptionCancellation(
	command SubscriptionCancellationCommand,
	current *SubscriptionRecord,
) CancellationPlan {
	prerequisite := cancellationPrerequisite(command, current)
	if prerequisite.Kind == CancellationPlanRequestProvider {
		prerequisite.Command.Effect = ProviderCancellationImmediate
	}
	return prerequisite
}

func cancellationPrerequisite(
	command SubscriptionCancellationCommand,
	current *SubscriptionRecord,
) CancellationPlan {
	if !validCancellationCommand(command) {
		return completedCancellation(CancellationInvalidCommand)
	}
	if current == nil {
		return completedCancellation(CancellationSubscriptionNotFound)
	}
	if !ValidRecord(*current) {
		return completedCancellation(CancellationInvalidCommand)
	}
	if current.AccountID != command.Scope.AccountID || current.VaultID != command.Scope.VaultID {
		return completedCancellation(CancellationOwnerMismatch)
	}
	if current.Lifecycle.Kind == LifecycleCancelled {
		if current.Lifecycle.CancelledAt > command.RequestedAt {
			return completedCancellation(CancellationInvalidSubscriptionState)
		}
		confirmedAt := current.Lifecycle.CancelledAt
		if current.CancellationUpdatedAt != nil {
			confirmedAt = *current.CancellationUpdatedAt
		}
		return CancellationPlan{
			Kind: CancellationPlanComplete,
			Result: SubscriptionCancellationResult{
				Kind: SubscriptionCancellationConfirmed, Outcome: SubscriptionAlreadyCancelled,
				ConfirmedAt: confirmedAt, AccessEndsAt: current.Lifecycle.CancelledAt,
			},
		}
	}
	if current.ProviderSubscriptionReference == "" {
		return completedCancellation(CancellationProviderNotLinked)
	}
	return CancellationPlan{
		Kind: CancellationPlanRequestProvider,
		Command: ProviderCancellationCommand{
			Provider: current.Provider, ProviderSubscriptionReference: current.ProviderSubscriptionReference,
			IdempotencyKey: command.IdempotencyKey, RequestedAt: command.RequestedAt,
		},
	}
}

func EvaluatePeriodEndProviderCancellation(
	command ProviderCancellationCommand,
	observation ProviderCancellationObservation,
) SubscriptionCancellationResult {
	if command.Effect != ProviderCancellationPeriodEnd || !providerResultMatches(command, observation) {
		return retryableCancellation(CancellationProviderResultMismatch)
	}
	switch observation.Kind {
	case ProviderCancellationScheduled:
		if observation.AccessEndsAt < observation.ObservedAt || observation.AccessEndsAt < command.RequestedAt {
			return retryableCancellation(CancellationProviderResultMismatch)
		}
		return confirmedCancellation(SubscriptionCancellationScheduled, observation)
	case ProviderCancellationAlreadyCancelled:
		if observation.AccessEndsAt > observation.ObservedAt {
			return retryableCancellation(CancellationProviderResultMismatch)
		}
		return confirmedCancellation(SubscriptionAlreadyCancelled, observation)
	case ProviderCancellationCancelled:
		return retryableCancellation(CancellationProviderResultMismatch)
	case ProviderCancellationRetryableFailure:
		return retryableCancellation(CancellationProviderUnavailable)
	case ProviderCancellationTerminalFailure:
		return terminalCancellation(CancellationProviderTerminal)
	default:
		return retryableCancellation(CancellationMalformedProviderResponse)
	}
}

func EvaluateImmediateProviderCancellation(
	command ProviderCancellationCommand,
	observation ProviderCancellationObservation,
) SubscriptionCancellationResult {
	if command.Effect != ProviderCancellationImmediate || !providerResultMatches(command, observation) {
		return retryableCancellation(CancellationProviderResultMismatch)
	}
	switch observation.Kind {
	case ProviderCancellationCancelled, ProviderCancellationAlreadyCancelled:
		if observation.AccessEndsAt > observation.ObservedAt {
			return retryableCancellation(CancellationProviderResultMismatch)
		}
		outcome := SubscriptionCancelled
		if observation.Kind == ProviderCancellationAlreadyCancelled {
			outcome = SubscriptionAlreadyCancelled
		}
		return confirmedCancellation(outcome, observation)
	case ProviderCancellationScheduled:
		return retryableCancellation(CancellationProviderResultMismatch)
	case ProviderCancellationRetryableFailure:
		return retryableCancellation(CancellationProviderUnavailable)
	case ProviderCancellationTerminalFailure:
		return terminalCancellation(CancellationProviderTerminal)
	default:
		return retryableCancellation(CancellationMalformedProviderResponse)
	}
}

func providerResultMatches(
	command ProviderCancellationCommand,
	observation ProviderCancellationObservation,
) bool {
	return validProviderCancellationCommand(command) && ValidProviderCancellationObservation(observation) &&
		observation.Provider == command.Provider &&
		observation.ProviderSubscriptionReference == command.ProviderSubscriptionReference &&
		observation.IdempotencyKey == command.IdempotencyKey
}

func ValidProviderCancellationObservation(observation ProviderCancellationObservation) bool {
	if _, err := ParseProvider(string(observation.Provider)); err != nil {
		return false
	}
	if _, err := ParseProviderSubscriptionReference(string(observation.ProviderSubscriptionReference)); err != nil {
		return false
	}
	if _, err := ParseCancellationIdempotencyKey(string(observation.IdempotencyKey)); err != nil {
		return false
	}
	if !validTimestamp(observation.ObservedAt) {
		return false
	}
	switch observation.Kind {
	case ProviderCancellationScheduled, ProviderCancellationCancelled, ProviderCancellationAlreadyCancelled:
		return validTimestamp(observation.AccessEndsAt)
	case ProviderCancellationRetryableFailure, ProviderCancellationTerminalFailure:
		return observation.AccessEndsAt == 0
	default:
		return false
	}
}

func (service *CancellationService) ScheduleSubscriptionCancellation(
	ctx context.Context,
	command SubscriptionCancellationCommand,
) (SubscriptionCancellationResult, error) {
	return service.execute(ctx, command, PlanPeriodEndSubscriptionCancellation, EvaluatePeriodEndProviderCancellation)
}

func (service *CancellationService) CancelSubscriptionImmediately(
	ctx context.Context,
	command SubscriptionCancellationCommand,
) (SubscriptionCancellationResult, error) {
	return service.execute(ctx, command, PlanImmediateSubscriptionCancellation, EvaluateImmediateProviderCancellation)
}

type cancellationPlanner func(SubscriptionCancellationCommand, *SubscriptionRecord) CancellationPlan
type cancellationEvaluator func(ProviderCancellationCommand, ProviderCancellationObservation) SubscriptionCancellationResult

func (service *CancellationService) execute(
	ctx context.Context,
	command SubscriptionCancellationCommand,
	planCancellation cancellationPlanner,
	evaluateCancellation cancellationEvaluator,
) (SubscriptionCancellationResult, error) {
	if service == nil || service.repository == nil || service.provider == nil ||
		planCancellation == nil || evaluateCancellation == nil {
		return SubscriptionCancellationResult{}, ErrInvalidCancellationConfiguration
	}
	current, err := service.repository.FindByOwner(ctx, command.Scope)
	if err != nil {
		return SubscriptionCancellationResult{}, err
	}
	plan := planCancellation(command, current)
	if plan.Kind == CancellationPlanComplete {
		return plan.Result, nil
	}
	if plan.Kind != CancellationPlanRequestProvider {
		return retryableCancellation(CancellationMalformedProviderResponse), nil
	}
	observation, err := service.provider.CancelSubscription(ctx, plan.Command)
	if err != nil {
		return retryableCancellation(CancellationProviderUnavailable), nil
	}
	if !ValidProviderCancellationObservation(observation) {
		return retryableCancellation(CancellationMalformedProviderResponse), nil
	}
	return evaluateCancellation(plan.Command, observation), nil
}

func validCancellationCommand(command SubscriptionCancellationCommand) bool {
	if !command.Scope.Valid() || !validTimestamp(command.RequestedAt) {
		return false
	}
	_, err := ParseCancellationIdempotencyKey(string(command.IdempotencyKey))
	return err == nil
}

func validProviderCancellationCommand(command ProviderCancellationCommand) bool {
	if _, err := ParseProvider(string(command.Provider)); err != nil {
		return false
	}
	if _, err := ParseProviderSubscriptionReference(string(command.ProviderSubscriptionReference)); err != nil {
		return false
	}
	if _, err := ParseCancellationIdempotencyKey(string(command.IdempotencyKey)); err != nil {
		return false
	}
	if command.Effect != ProviderCancellationPeriodEnd && command.Effect != ProviderCancellationImmediate {
		return false
	}
	return validTimestamp(command.RequestedAt)
}

func completedCancellation(reason SubscriptionCancellationReason) CancellationPlan {
	return CancellationPlan{Kind: CancellationPlanComplete, Result: terminalCancellation(reason)}
}

func confirmedCancellation(
	outcome SubscriptionCancellationOutcome,
	observation ProviderCancellationObservation,
) SubscriptionCancellationResult {
	return SubscriptionCancellationResult{
		Kind: SubscriptionCancellationConfirmed, Outcome: outcome,
		ConfirmedAt: observation.ObservedAt, AccessEndsAt: observation.AccessEndsAt,
	}
}

func retryableCancellation(reason SubscriptionCancellationReason) SubscriptionCancellationResult {
	return SubscriptionCancellationResult{Kind: SubscriptionCancellationRetryableFailure, Reason: reason}
}

func terminalCancellation(reason SubscriptionCancellationReason) SubscriptionCancellationResult {
	return SubscriptionCancellationResult{Kind: SubscriptionCancellationTerminalFailure, Reason: reason}
}
