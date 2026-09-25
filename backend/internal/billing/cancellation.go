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

type ProviderCancellationCommand struct {
	Provider                      Provider
	ProviderSubscriptionReference ProviderSubscriptionReference
	IdempotencyKey                CancellationIdempotencyKey
	RequestedAt                   int64
}

type ProviderCancellationKind string

const (
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
}

type SubscriptionCancellationResultKind string
type SubscriptionCancellationOutcome string
type SubscriptionCancellationReason string

const (
	SubscriptionCancellationConfirmed        SubscriptionCancellationResultKind = "confirmed"
	SubscriptionCancellationRetryableFailure SubscriptionCancellationResultKind = "retryable-failure"
	SubscriptionCancellationTerminalFailure  SubscriptionCancellationResultKind = "terminal-failure"

	SubscriptionCancelled        SubscriptionCancellationOutcome = "cancelled"
	SubscriptionAlreadyCancelled SubscriptionCancellationOutcome = "already-cancelled"

	CancellationInvalidCommand            SubscriptionCancellationReason = "invalid-command"
	CancellationOwnerMismatch             SubscriptionCancellationReason = "owner-mismatch"
	CancellationSubscriptionNotFound      SubscriptionCancellationReason = "subscription-not-found"
	CancellationProviderNotLinked         SubscriptionCancellationReason = "provider-not-linked"
	CancellationProviderUnavailable       SubscriptionCancellationReason = "provider-unavailable"
	CancellationMalformedProviderResponse SubscriptionCancellationReason = "malformed-provider-response"
	CancellationProviderResultMismatch    SubscriptionCancellationReason = "provider-result-mismatch"
	CancellationProviderTerminal          SubscriptionCancellationReason = "provider-terminal"
)

type SubscriptionCancellationResult struct {
	Kind        SubscriptionCancellationResultKind
	Outcome     SubscriptionCancellationOutcome
	Reason      SubscriptionCancellationReason
	ConfirmedAt int64
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

type SubscriptionCancellationPort interface {
	CancelSubscription(context.Context, SubscriptionCancellationCommand) (SubscriptionCancellationResult, error)
}

type CancellationService struct {
	repository SubscriptionCancellationLookup
	provider   SubscriptionCancellationProviderPort
}

func NewCancellationService(
	repository SubscriptionCancellationLookup,
	provider SubscriptionCancellationProviderPort,
) (*CancellationService, error) {
	if repository == nil || provider == nil {
		return nil, ErrInvalidCancellationConfiguration
	}
	return &CancellationService{repository: repository, provider: provider}, nil
}

func PlanSubscriptionCancellation(
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
		return CancellationPlan{
			Kind: CancellationPlanComplete,
			Result: SubscriptionCancellationResult{
				Kind: SubscriptionCancellationConfirmed, Outcome: SubscriptionAlreadyCancelled,
				ConfirmedAt: current.Lifecycle.CancelledAt,
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

func EvaluateProviderCancellation(
	command ProviderCancellationCommand,
	observation ProviderCancellationObservation,
) SubscriptionCancellationResult {
	if !validProviderCancellationCommand(command) || !ValidProviderCancellationObservation(observation) ||
		observation.Provider != command.Provider ||
		observation.ProviderSubscriptionReference != command.ProviderSubscriptionReference ||
		observation.IdempotencyKey != command.IdempotencyKey || observation.ObservedAt < command.RequestedAt {
		return retryableCancellation(CancellationProviderResultMismatch)
	}
	switch observation.Kind {
	case ProviderCancellationCancelled:
		return SubscriptionCancellationResult{
			Kind: SubscriptionCancellationConfirmed, Outcome: SubscriptionCancelled,
			ConfirmedAt: observation.ObservedAt,
		}
	case ProviderCancellationAlreadyCancelled:
		return SubscriptionCancellationResult{
			Kind: SubscriptionCancellationConfirmed, Outcome: SubscriptionAlreadyCancelled,
			ConfirmedAt: observation.ObservedAt,
		}
	case ProviderCancellationRetryableFailure:
		return retryableCancellation(CancellationProviderUnavailable)
	case ProviderCancellationTerminalFailure:
		return terminalCancellation(CancellationProviderTerminal)
	default:
		return retryableCancellation(CancellationMalformedProviderResponse)
	}
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
	case ProviderCancellationCancelled, ProviderCancellationAlreadyCancelled,
		ProviderCancellationRetryableFailure, ProviderCancellationTerminalFailure:
		return true
	default:
		return false
	}
}

func (service *CancellationService) CancelSubscription(
	ctx context.Context,
	command SubscriptionCancellationCommand,
) (SubscriptionCancellationResult, error) {
	if service == nil || service.repository == nil || service.provider == nil {
		return SubscriptionCancellationResult{}, ErrInvalidCancellationConfiguration
	}
	current, err := service.repository.FindByOwner(ctx, command.Scope)
	if err != nil {
		return SubscriptionCancellationResult{}, err
	}
	plan := PlanSubscriptionCancellation(command, current)
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
	return EvaluateProviderCancellation(plan.Command, observation), nil
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
	return validTimestamp(command.RequestedAt)
}

func completedCancellation(reason SubscriptionCancellationReason) CancellationPlan {
	return CancellationPlan{Kind: CancellationPlanComplete, Result: terminalCancellation(reason)}
}

func retryableCancellation(reason SubscriptionCancellationReason) SubscriptionCancellationResult {
	return SubscriptionCancellationResult{Kind: SubscriptionCancellationRetryableFailure, Reason: reason}
}

func terminalCancellation(reason SubscriptionCancellationReason) SubscriptionCancellationResult {
	return SubscriptionCancellationResult{Kind: SubscriptionCancellationTerminalFailure, Reason: reason}
}
