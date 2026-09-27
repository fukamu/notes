package accountdeletion

import "context"

type LegalEvidenceFinalizationPolicyKind string

const (
	LegalEvidencePolicyUndecided LegalEvidenceFinalizationPolicyKind = "undecided"
	LegalEvidenceDeleteLive      LegalEvidenceFinalizationPolicyKind = "delete-live-evidence"
)

type LegalEvidenceFinalizationPolicy struct {
	Kind LegalEvidenceFinalizationPolicyKind
}

func ValidLegalEvidenceFinalizationPolicy(policy LegalEvidenceFinalizationPolicy) bool {
	return policy.Kind == LegalEvidencePolicyUndecided || policy.Kind == LegalEvidenceDeleteLive
}

type AccountFinalizationCommand struct {
	Scope             Scope
	OperationID       OperationID
	PreviousReceiptAt int64
	AttemptedAt       int64
}

func ValidAccountFinalizationCommand(command AccountFinalizationCommand) bool {
	if !ValidScope(command.Scope) || !validTimestamp(command.PreviousReceiptAt) ||
		!validTimestamp(command.AttemptedAt) || command.AttemptedAt < command.PreviousReceiptAt {
		return false
	}
	_, err := ParseOperationID(string(command.OperationID))
	return err == nil
}

type AccountFinalizationPlanKind string
type AccountFinalizationPlanReason string

const (
	AccountFinalizationPlanAccepted AccountFinalizationPlanKind = "accepted"
	AccountFinalizationPlanRejected AccountFinalizationPlanKind = "rejected"

	AccountFinalizationInvalidCommand AccountFinalizationPlanReason = "invalid-command"
	AccountFinalizationInvalidPolicy  AccountFinalizationPlanReason = "invalid-policy"
	AccountFinalizationScopeMismatch  AccountFinalizationPlanReason = "scope-mismatch"
)

type AccountFinalizationPlan struct {
	Kind    AccountFinalizationPlanKind
	Reason  AccountFinalizationPlanReason
	Command AccountFinalizationCommand
	Policy  LegalEvidenceFinalizationPolicy
}

func PlanAccountFinalization(
	scope Scope,
	command AccountFinalizationCommand,
	policy LegalEvidenceFinalizationPolicy,
) AccountFinalizationPlan {
	if !ValidAccountFinalizationCommand(command) {
		return AccountFinalizationPlan{Kind: AccountFinalizationPlanRejected, Reason: AccountFinalizationInvalidCommand}
	}
	if !ValidLegalEvidenceFinalizationPolicy(policy) {
		return AccountFinalizationPlan{Kind: AccountFinalizationPlanRejected, Reason: AccountFinalizationInvalidPolicy}
	}
	if command.Scope != scope {
		return AccountFinalizationPlan{Kind: AccountFinalizationPlanRejected, Reason: AccountFinalizationScopeMismatch}
	}
	return AccountFinalizationPlan{
		Kind: AccountFinalizationPlanAccepted, Command: command, Policy: policy,
	}
}

type AccountFinalizationResultKind string
type AccountFinalizationOutcome string
type AccountFinalizationFailureReason string

const (
	AccountFinalizationConfirmed        AccountFinalizationResultKind = "confirmed"
	AccountFinalizationRetryableFailure AccountFinalizationResultKind = "retryable-failure"
	AccountFinalizationTerminalFailure  AccountFinalizationResultKind = "terminal-failure"

	AccountFinalizationDeleted          AccountFinalizationOutcome = "deleted"
	AccountFinalizationAlreadyFinalized AccountFinalizationOutcome = "already-finalized"
	AccountFinalizationReady            AccountFinalizationOutcome = "ready"

	AccountFinalizationPrivateObjectsRemaining   AccountFinalizationFailureReason = "private-objects-remaining"
	AccountFinalizationPrivateObjectsUnavailable AccountFinalizationFailureReason = "private-objects-unavailable"
	AccountFinalizationLegalPolicyPending        AccountFinalizationFailureReason = "legal-evidence-policy-pending"
	AccountFinalizationLegalEvidenceUnavailable  AccountFinalizationFailureReason = "legal-evidence-unavailable"
	AccountFinalizationWrappedKeysRemaining      AccountFinalizationFailureReason = "wrapped-keys-remaining"
	AccountFinalizationWrappedKeysUnavailable    AccountFinalizationFailureReason = "wrapped-keys-unavailable"
	AccountFinalizationLiveStateRemaining        AccountFinalizationFailureReason = "live-state-remaining"
	AccountFinalizationLiveStateUnavailable      AccountFinalizationFailureReason = "live-state-unavailable"
	AccountFinalizationOwnerMismatch             AccountFinalizationFailureReason = "owner-mismatch"
	AccountFinalizationIntegrityFailure          AccountFinalizationFailureReason = "integrity-failure"
	AccountFinalizationCommandRejected           AccountFinalizationFailureReason = "command-rejected"
)

type AccountFinalizationResult struct {
	Kind    AccountFinalizationResultKind
	Outcome AccountFinalizationOutcome
	Reason  AccountFinalizationFailureReason
}

type AccountFinalizationGate interface {
	Evaluate(context.Context, AccountFinalizationCommand) (AccountFinalizationResult, error)
}

type LegalEvidenceFinalizationGate interface {
	EvaluateLegalEvidence(
		context.Context,
		AccountFinalizationCommand,
		LegalEvidenceFinalizationPolicy,
	) (AccountFinalizationResult, error)
}

type WrappedKeyFinalizationGate interface {
	FinalizeWrappedKeys(
		context.Context,
		AccountFinalizationCommand,
		LegalEvidenceFinalizationPolicy,
	) (AccountFinalizationResult, error)
}

type LiveStateFinalizationGate interface {
	FinalizeLiveState(
		context.Context,
		AccountFinalizationCommand,
		LegalEvidenceFinalizationPolicy,
	) (AccountFinalizationResult, error)
}

type AccountFinalizationEngine interface {
	Finalize(context.Context, AccountFinalizationCommand) (AccountFinalizationResult, error)
}

type AccountFinalizationService struct {
	scope          Scope
	policy         LegalEvidenceFinalizationPolicy
	privateObjects AccountFinalizationGate
	legalEvidence  LegalEvidenceFinalizationGate
	wrappedKeys    WrappedKeyFinalizationGate
	liveState      LiveStateFinalizationGate
}

func NewAccountFinalizationService(
	scope Scope,
	policy LegalEvidenceFinalizationPolicy,
	privateObjects AccountFinalizationGate,
	legalEvidence LegalEvidenceFinalizationGate,
	wrappedKeys WrappedKeyFinalizationGate,
	liveState LiveStateFinalizationGate,
) (*AccountFinalizationService, error) {
	if !ValidScope(scope) || !ValidLegalEvidenceFinalizationPolicy(policy) ||
		privateObjects == nil || legalEvidence == nil || wrappedKeys == nil || liveState == nil {
		return nil, ErrInvalidServiceConfiguration
	}
	return &AccountFinalizationService{
		scope: scope, policy: policy, privateObjects: privateObjects,
		legalEvidence: legalEvidence, wrappedKeys: wrappedKeys, liveState: liveState,
	}, nil
}

func (service *AccountFinalizationService) Finalize(
	ctx context.Context,
	command AccountFinalizationCommand,
) (AccountFinalizationResult, error) {
	if service == nil || service.privateObjects == nil || service.legalEvidence == nil ||
		service.wrappedKeys == nil || service.liveState == nil {
		return AccountFinalizationResult{}, ErrInvalidServiceConfiguration
	}
	plan := PlanAccountFinalization(service.scope, command, service.policy)
	if plan.Kind != AccountFinalizationPlanAccepted {
		return terminalAccountFinalization(AccountFinalizationCommandRejected), nil
	}

	result, err := service.privateObjects.Evaluate(ctx, plan.Command)
	if decision := evaluateFinalizationStage(result, err, finalizationStagePrivateObjects); decision.Kind != AccountFinalizationConfirmed {
		return decision, nil
	}
	result, err = service.legalEvidence.EvaluateLegalEvidence(ctx, plan.Command, plan.Policy)
	if decision := evaluateFinalizationStage(result, err, finalizationStageLegalEvidence); decision.Kind != AccountFinalizationConfirmed {
		return decision, nil
	}
	result, err = service.wrappedKeys.FinalizeWrappedKeys(ctx, plan.Command, plan.Policy)
	if decision := evaluateFinalizationStage(result, err, finalizationStageWrappedKeys); decision.Kind != AccountFinalizationConfirmed {
		return decision, nil
	}
	result, err = service.liveState.FinalizeLiveState(ctx, plan.Command, plan.Policy)
	return evaluateFinalizationStage(result, err, finalizationStageLiveState), nil
}

type finalizationStage string

const (
	finalizationStagePrivateObjects finalizationStage = "private-objects"
	finalizationStageLegalEvidence  finalizationStage = "legal-evidence"
	finalizationStageWrappedKeys    finalizationStage = "wrapped-keys"
	finalizationStageLiveState      finalizationStage = "live-state"
)

func evaluateFinalizationStage(
	result AccountFinalizationResult,
	err error,
	stage finalizationStage,
) AccountFinalizationResult {
	if err != nil || !validFinalizationStageResult(result, stage) {
		return retryableAccountFinalization(unavailableReason(stage))
	}
	return result
}

func validFinalizationStageResult(result AccountFinalizationResult, stage finalizationStage) bool {
	switch result.Kind {
	case AccountFinalizationConfirmed:
		if result.Reason != "" {
			return false
		}
		if stage == finalizationStageLiveState {
			return result.Outcome == AccountFinalizationDeleted ||
				result.Outcome == AccountFinalizationAlreadyFinalized
		}
		return result.Outcome == AccountFinalizationReady ||
			result.Outcome == AccountFinalizationAlreadyFinalized
	case AccountFinalizationRetryableFailure:
		if result.Outcome != "" {
			return false
		}
		switch stage {
		case finalizationStagePrivateObjects:
			return result.Reason == AccountFinalizationPrivateObjectsRemaining ||
				result.Reason == AccountFinalizationPrivateObjectsUnavailable
		case finalizationStageLegalEvidence:
			return result.Reason == AccountFinalizationLegalPolicyPending ||
				result.Reason == AccountFinalizationLegalEvidenceUnavailable
		case finalizationStageWrappedKeys:
			return result.Reason == AccountFinalizationPrivateObjectsRemaining ||
				result.Reason == AccountFinalizationLegalPolicyPending ||
				result.Reason == AccountFinalizationWrappedKeysRemaining ||
				result.Reason == AccountFinalizationWrappedKeysUnavailable
		case finalizationStageLiveState:
			return result.Reason == AccountFinalizationLegalPolicyPending ||
				result.Reason == AccountFinalizationLiveStateRemaining ||
				result.Reason == AccountFinalizationLiveStateUnavailable
		}
	case AccountFinalizationTerminalFailure:
		return result.Outcome == "" && (result.Reason == AccountFinalizationOwnerMismatch ||
			result.Reason == AccountFinalizationIntegrityFailure)
	}
	return false
}

func unavailableReason(stage finalizationStage) AccountFinalizationFailureReason {
	switch stage {
	case finalizationStagePrivateObjects:
		return AccountFinalizationPrivateObjectsUnavailable
	case finalizationStageLegalEvidence:
		return AccountFinalizationLegalEvidenceUnavailable
	case finalizationStageWrappedKeys:
		return AccountFinalizationWrappedKeysUnavailable
	default:
		return AccountFinalizationLiveStateUnavailable
	}
}

func confirmedAccountFinalization(outcome AccountFinalizationOutcome) AccountFinalizationResult {
	return AccountFinalizationResult{Kind: AccountFinalizationConfirmed, Outcome: outcome}
}

func retryableAccountFinalization(reason AccountFinalizationFailureReason) AccountFinalizationResult {
	return AccountFinalizationResult{Kind: AccountFinalizationRetryableFailure, Reason: reason}
}

func terminalAccountFinalization(reason AccountFinalizationFailureReason) AccountFinalizationResult {
	return AccountFinalizationResult{Kind: AccountFinalizationTerminalFailure, Reason: reason}
}

type AccountFinalizationEffect struct {
	engine AccountFinalizationEngine
}

var _ AccountFinalizationPort = (*AccountFinalizationEffect)(nil)

func NewAccountFinalizationEffect(engine AccountFinalizationEngine) (*AccountFinalizationEffect, error) {
	if engine == nil {
		return nil, ErrInvalidServiceConfiguration
	}
	return &AccountFinalizationEffect{engine: engine}, nil
}

func (effect *AccountFinalizationEffect) FinalizeAccount(
	ctx context.Context,
	input StepEffectInput,
) (StepEffectResult, error) {
	if effect == nil || effect.engine == nil || !ValidStepEffectInput(input, StepFinalizeAccount) {
		return terminalEffect("account-finalization-command-rejected"), nil
	}
	result, err := effect.engine.Finalize(ctx, AccountFinalizationCommand{
		Scope: input.Scope, OperationID: input.OperationID,
		PreviousReceiptAt: input.RequestedAt, AttemptedAt: input.ExecutedAt,
	})
	if err != nil {
		return retryableEffect("account-finalization-unavailable"), nil
	}
	switch result.Kind {
	case AccountFinalizationConfirmed:
		return StepEffectResult{Kind: EffectSucceeded}, nil
	case AccountFinalizationRetryableFailure:
		switch result.Reason {
		case AccountFinalizationPrivateObjectsRemaining:
			return retryableEffect("private-object-reconfirmation-incomplete"), nil
		case AccountFinalizationPrivateObjectsUnavailable:
			return retryableEffect("private-object-reconfirmation-unavailable"), nil
		case AccountFinalizationLegalPolicyPending:
			return retryableEffect("legal-evidence-policy-pending"), nil
		case AccountFinalizationLegalEvidenceUnavailable:
			return retryableEffect("legal-evidence-unavailable"), nil
		case AccountFinalizationWrappedKeysRemaining:
			return retryableEffect("wrapped-key-finalization-incomplete"), nil
		case AccountFinalizationWrappedKeysUnavailable:
			return retryableEffect("wrapped-key-finalization-unavailable"), nil
		case AccountFinalizationLiveStateRemaining:
			return retryableEffect("account-live-state-incomplete"), nil
		default:
			return retryableEffect("account-live-state-unavailable"), nil
		}
	case AccountFinalizationTerminalFailure:
		if result.Reason == AccountFinalizationOwnerMismatch {
			return terminalEffect("account-finalization-owner-mismatch"), nil
		}
		return terminalEffect("account-finalization-command-rejected"), nil
	default:
		return retryableEffect("account-finalization-unavailable"), nil
	}
}
