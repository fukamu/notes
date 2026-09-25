package accountdeletion

import (
	"context"
	"errors"
)

var ErrInvalidServiceConfiguration = errors.New("invalid account deletion service configuration")

type CredentialBundle struct {
	IdempotencyHash CredentialHash
	Secret          ContinuationSecret
	SecretHash      CredentialHash
}

type CredentialPort interface {
	Derive(Scope, IdempotencyKey) (CredentialBundle, error)
	DigestSecret(ContinuationSecret) (CredentialHash, error)
}

type StepEffectInput struct {
	Scope       Scope
	OperationID OperationID
	Step        Step
	Attempt     int64
	RequestedAt int64
	ExecutedAt  int64
}

func ValidStepEffectInput(input StepEffectInput, expected Step) bool {
	if !ValidScope(input.Scope) || input.Step != expected || input.Attempt < 1 || input.Attempt > MaximumAttempt {
		return false
	}
	if _, err := ParseOperationID(string(input.OperationID)); err != nil {
		return false
	}
	return validTimestamp(input.RequestedAt) && validTimestamp(input.ExecutedAt) &&
		input.ExecutedAt >= input.RequestedAt
}

type StepEffectResultKind string

const (
	EffectSucceeded        StepEffectResultKind = "succeeded"
	EffectRetryableFailure StepEffectResultKind = "retryable-failure"
	EffectTerminalFailure  StepEffectResultKind = "terminal-failure"
)

type StepEffectResult struct {
	Kind        StepEffectResultKind
	FailureCode FailureCode
}

type SessionRevocationPort interface {
	RevokeSessions(context.Context, StepEffectInput) (StepEffectResult, error)
}

type ImmediateCancellationPort interface {
	CancelSubscriptionImmediately(context.Context, StepEffectInput) (StepEffectResult, error)
}

type VaultDataPurgePort interface {
	DeleteVaultData(context.Context, StepEffectInput) (StepEffectResult, error)
}

type PrivateObjectPurgePort interface {
	DeletePrivateObjects(context.Context, StepEffectInput) (StepEffectResult, error)
}

type AccountFinalizationPort interface {
	FinalizeAccount(context.Context, StepEffectInput) (StepEffectResult, error)
}

type ServiceOptions struct {
	Repository           Repository
	Credentials          CredentialPort
	Sessions             SessionRevocationPort
	Subscriptions        ImmediateCancellationPort
	VaultData            VaultDataPurgePort
	PrivateObjects       PrivateObjectPurgePort
	Accounts             AccountFinalizationPort
	ContinuationLifetime int64
	LeaseDuration        int64
	RetryPolicy          RetryPolicy
}

type ApplicationResultKind string
type ApplicationRejectReason string

const (
	ApplicationAccepted ApplicationResultKind = "accepted"
	ApplicationRejected ApplicationResultKind = "rejected"

	ApplicationCredentialConflict ApplicationRejectReason = "credential-conflict"
	ApplicationInvalidCapability  ApplicationRejectReason = "invalid-capability"
	ApplicationInvalidInput       ApplicationRejectReason = "invalid-input"
	ApplicationUnavailable        ApplicationRejectReason = "unavailable"
)

type ApplicationResult struct {
	Kind     ApplicationResultKind
	Reason   ApplicationRejectReason
	Response *PublicResponse
}

type Service struct {
	repository           Repository
	credentials          CredentialPort
	sessions             SessionRevocationPort
	subscriptions        ImmediateCancellationPort
	vaultData            VaultDataPurgePort
	privateObjects       PrivateObjectPurgePort
	accounts             AccountFinalizationPort
	continuationLifetime int64
	leaseDuration        int64
	retryPolicy          RetryPolicy
}

func NewService(options ServiceOptions) (*Service, error) {
	if options.Repository == nil || options.Credentials == nil || options.Sessions == nil ||
		options.Subscriptions == nil || options.VaultData == nil || options.PrivateObjects == nil ||
		options.Accounts == nil || options.ContinuationLifetime <= 0 || options.LeaseDuration <= 0 ||
		!ValidRetryPolicy(options.RetryPolicy) {
		return nil, ErrInvalidServiceConfiguration
	}
	return &Service{
		repository: options.Repository, credentials: options.Credentials,
		sessions: options.Sessions, subscriptions: options.Subscriptions,
		vaultData: options.VaultData, privateObjects: options.PrivateObjects,
		accounts: options.Accounts, continuationLifetime: options.ContinuationLifetime,
		leaseDuration: options.LeaseDuration,
		retryPolicy:   RetryPolicy{DelaysMilli: append([]int64(nil), options.RetryPolicy.DelaysMilli...)},
	}, nil
}

func (service *Service) Start(
	ctx context.Context,
	scope Scope,
	command StartCommand,
	operationID OperationID,
	requestedAt int64,
) (ApplicationResult, error) {
	if !service.valid() || requestedAt > identityMaximumSafeInteger()-service.continuationLifetime {
		return rejectedApplication(ApplicationUnavailable), nil
	}
	if _, err := ParseIdempotencyKey(string(command.IdempotencyKey)); err != nil {
		return rejectedApplication(ApplicationInvalidInput), nil
	}
	operationPlan := PlanStart(scope, operationID, requestedAt)
	if operationPlan.Kind != PlanAccepted {
		return rejectedApplication(ApplicationInvalidInput), nil
	}
	credentials, err := service.credentials.Derive(scope, command.IdempotencyKey)
	if err != nil || !validCredentialBundle(credentials) {
		return rejectedApplication(ApplicationUnavailable), nil
	}
	continuationPlan := PlanContinuationStart(
		operationPlan.Operation, credentials.IdempotencyHash, credentials.SecretHash,
		requestedAt+service.continuationLifetime,
	)
	if continuationPlan.Kind != ContinuationStartAccepted {
		return rejectedApplication(ApplicationInvalidInput), nil
	}
	started, err := service.repository.Start(ctx, operationPlan.Operation, continuationPlan.Continuation)
	if err != nil {
		return ApplicationResult{}, err
	}
	switch started.Kind {
	case StartCreated, StartExisting:
		return acceptedApplication(started.Snapshot, credentials.Secret, started.Continuation.Sequence)
	case StartRejected:
		if started.Reason == StartCredentialConflict {
			return rejectedApplication(ApplicationCredentialConflict), nil
		}
		return rejectedApplication(ApplicationUnavailable), nil
	default:
		return rejectedApplication(ApplicationUnavailable), nil
	}
}

func (service *Service) Resume(
	ctx context.Context,
	command ResumeCommand,
	resumedAt int64,
) (ApplicationResult, error) {
	if !service.valid() {
		return rejectedApplication(ApplicationUnavailable), nil
	}
	secret, sequence, err := ContinuationTokenParts(command.ContinuationToken)
	if err != nil {
		return rejectedApplication(ApplicationInvalidCapability), nil
	}
	secretHash, err := service.credentials.DigestSecret(secret)
	if err != nil {
		return rejectedApplication(ApplicationUnavailable), nil
	}
	consumed, err := service.repository.Consume(ctx, secretHash, sequence, resumedAt)
	if err != nil {
		return ApplicationResult{}, err
	}
	switch consumed.Kind {
	case ConsumeConsumed:
		return service.run(ctx, consumed.AuthorizedSnapshot, secret, resumedAt)
	case ConsumeReplayed:
		return acceptedApplication(consumed.Snapshot, secret, consumed.Continuation.Sequence)
	case ConsumeRejected:
		return rejectedApplication(ApplicationInvalidCapability), nil
	default:
		return rejectedApplication(ApplicationUnavailable), nil
	}
}

func (service *Service) run(
	ctx context.Context,
	authorized AuthorizedSnapshot,
	secret ContinuationSecret,
	now int64,
) (ApplicationResult, error) {
	plan := PlanRun(authorized.Snapshot, now, service.leaseDuration, service.retryPolicy)
	switch plan.Kind {
	case RunReport:
		return acceptedApplication(authorized.Snapshot, secret, authorized.Continuation.Sequence)
	case RunAdvanceState:
		committed, err := service.repository.Commit(ctx, authorized.Snapshot.Operation.Scope, plan.Transition)
		if err != nil {
			return ApplicationResult{}, err
		}
		return service.resultFromCommit(committed, secret, authorized.Continuation.Sequence)
	case RunClaimStep:
		claimed, err := service.repository.Commit(ctx, authorized.Snapshot.Operation.Scope, plan.Transition)
		if err != nil {
			return ApplicationResult{}, err
		}
		if claimed.Kind != CommitApplied || claimed.Current == nil {
			return service.resultFromCommit(claimed, secret, authorized.Continuation.Sequence)
		}
		return service.executeClaimedStep(ctx, *claimed.Current, secret, authorized.Continuation.Sequence, now)
	default:
		return rejectedApplication(ApplicationUnavailable), nil
	}
}

func (service *Service) executeClaimedStep(
	ctx context.Context,
	snapshot Snapshot,
	secret ContinuationSecret,
	sequence int64,
	finishedAt int64,
) (ApplicationResult, error) {
	running, ok := snapshot.Operation.State.(Running)
	if !ok {
		return rejectedApplication(ApplicationUnavailable), nil
	}
	input := StepEffectInput{
		Scope: snapshot.Operation.Scope, OperationID: snapshot.Operation.OperationID,
		Step: running.Step, Attempt: running.Attempt,
		RequestedAt: effectRequestedAt(snapshot), ExecutedAt: finishedAt,
	}
	effect := service.executeEffect(ctx, input)
	result := StepResult{Step: running.Step, Attempt: running.Attempt, FinishedAt: finishedAt}
	switch effect.Kind {
	case EffectSucceeded:
		result.Kind = StepSucceeded
	case EffectRetryableFailure:
		result.Kind = StepRetryableFailure
		result.FailureCode = effect.FailureCode
	case EffectTerminalFailure:
		result.Kind = StepTerminalFailure
		result.FailureCode = effect.FailureCode
	default:
		result.Kind = StepRetryableFailure
		result.FailureCode, _ = ParseFailureCode("effect-unavailable")
	}
	completion := PlanStepCompletion(snapshot.Operation, result, receiptForStep(snapshot, running.Step), service.retryPolicy)
	if completion.Kind == PlanReplayed {
		return acceptedApplication(snapshot, secret, sequence)
	}
	if completion.Kind != PlanAccepted {
		return rejectedApplication(ApplicationUnavailable), nil
	}
	committed, err := service.repository.Commit(ctx, snapshot.Operation.Scope, completion.Transition)
	if err != nil {
		return ApplicationResult{}, err
	}
	return service.resultFromCommit(committed, secret, sequence)
}

func effectRequestedAt(snapshot Snapshot) int64 {
	if len(snapshot.Receipts) == 0 {
		return snapshot.Operation.CreatedAt
	}
	return snapshot.Receipts[len(snapshot.Receipts)-1].CompletedAt
}

func (service *Service) executeEffect(ctx context.Context, input StepEffectInput) StepEffectResult {
	var result StepEffectResult
	var err error
	switch input.Step {
	case StepRevokeSessions:
		result, err = service.sessions.RevokeSessions(ctx, input)
	case StepCancelSubscription:
		result, err = service.subscriptions.CancelSubscriptionImmediately(ctx, input)
	case StepDeleteVaultData:
		result, err = service.vaultData.DeleteVaultData(ctx, input)
	case StepDeletePrivateObject:
		result, err = service.privateObjects.DeletePrivateObjects(ctx, input)
	case StepFinalizeAccount:
		result, err = service.accounts.FinalizeAccount(ctx, input)
	default:
		err = ErrInvalidServiceConfiguration
	}
	if err != nil || !validEffectResult(result) {
		code, _ := ParseFailureCode("effect-unavailable")
		return StepEffectResult{Kind: EffectRetryableFailure, FailureCode: code}
	}
	return result
}

func (service *Service) resultFromCommit(
	result CommitResult,
	secret ContinuationSecret,
	sequence int64,
) (ApplicationResult, error) {
	switch result.Kind {
	case CommitApplied, CommitReplayed, CommitConflict:
		if result.Current == nil {
			return rejectedApplication(ApplicationUnavailable), nil
		}
		return acceptedApplication(*result.Current, secret, sequence)
	case CommitRejected:
		return rejectedApplication(ApplicationInvalidInput), nil
	default:
		return rejectedApplication(ApplicationUnavailable), nil
	}
}

func acceptedApplication(snapshot Snapshot, secret ContinuationSecret, sequence int64) (ApplicationResult, error) {
	status, ok := PublicStatusFromSnapshot(snapshot)
	if !ok {
		return rejectedApplication(ApplicationUnavailable), nil
	}
	response := PublicResponse{Status: status.Kind, RetryAt: status.RetryAt}
	if status.Kind == PublicInProgress || status.Kind == PublicRetryWait {
		token, err := CreateContinuationToken(secret, sequence)
		if err != nil {
			return rejectedApplication(ApplicationUnavailable), nil
		}
		response.ContinuationToken = token
	}
	return ApplicationResult{Kind: ApplicationAccepted, Response: &response}, nil
}

func rejectedApplication(reason ApplicationRejectReason) ApplicationResult {
	return ApplicationResult{Kind: ApplicationRejected, Reason: reason}
}

func receiptForStep(snapshot Snapshot, step Step) *Receipt {
	for index := range snapshot.Receipts {
		if snapshot.Receipts[index].Step == step {
			return &snapshot.Receipts[index]
		}
	}
	return nil
}

func validCredentialBundle(bundle CredentialBundle) bool {
	_, idempotencyErr := ParseCredentialHash(string(bundle.IdempotencyHash))
	_, secretErr := ParseContinuationSecret(string(bundle.Secret))
	_, hashErr := ParseCredentialHash(string(bundle.SecretHash))
	return idempotencyErr == nil && secretErr == nil && hashErr == nil
}

func validEffectResult(result StepEffectResult) bool {
	switch result.Kind {
	case EffectSucceeded:
		return result.FailureCode == ""
	case EffectRetryableFailure, EffectTerminalFailure:
		_, err := ParseFailureCode(string(result.FailureCode))
		return err == nil
	default:
		return false
	}
}

func (service *Service) valid() bool {
	return service != nil && service.repository != nil && service.credentials != nil &&
		service.sessions != nil && service.subscriptions != nil && service.vaultData != nil &&
		service.privateObjects != nil && service.accounts != nil && service.continuationLifetime > 0 &&
		service.leaseDuration > 0 && ValidRetryPolicy(service.retryPolicy)
}

// Kept local so application.go does not expose the identity package through
// its public contract solely for an overflow check.
func identityMaximumSafeInteger() int64 { return 9_007_199_254_740_991 }
