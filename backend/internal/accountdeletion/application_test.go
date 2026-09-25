package accountdeletion

import (
	"context"
	"errors"
	"strings"
	"testing"
)

func TestServiceConsumesBeforeEffectsAndReplaysWithoutDuplicates(t *testing.T) {
	repository := &applicationRepository{}
	credentials := applicationCredentials(t)
	effects := &applicationEffects{}
	service := newApplicationService(t, repository, credentials, effects)
	scope := mustApplicationScope(t)
	operationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000002801")
	idempotencyKey, _ := ParseIdempotencyKey(strings.Repeat("I", 43))

	started, err := service.Start(context.Background(), scope, StartCommand{IdempotencyKey: idempotencyKey}, operationID, 1_000)
	if err != nil || started.Kind != ApplicationAccepted || started.Response == nil ||
		started.Response.Status != PublicInProgress || effects.calls[StepRevokeSessions] != 0 {
		t.Fatalf("Start() = %#v, calls=%v, %v", started, effects.calls, err)
	}
	if state, ok := repository.snapshot.Operation.State.(Ready); !ok || state.Step != StepRevokeSessions || len(repository.snapshot.Receipts) != 0 {
		t.Fatalf("post-start snapshot = %#v", repository.snapshot)
	}
	originalToken := started.Response.ContinuationToken

	resumed, err := service.Resume(context.Background(), ResumeCommand{ContinuationToken: originalToken}, 1_100)
	if err != nil || resumed.Kind != ApplicationAccepted || resumed.Response == nil ||
		resumed.Response.Status != PublicInProgress || resumed.Response.ContinuationToken == originalToken ||
		effects.calls[StepRevokeSessions] != 1 {
		t.Fatalf("Resume() = %#v, calls=%v, %v", resumed, effects.calls, err)
	}
	replayed, err := service.Resume(context.Background(), ResumeCommand{ContinuationToken: originalToken}, 1_101)
	if err != nil || replayed.Kind != ApplicationAccepted || replayed.Response == nil ||
		replayed.Response.ContinuationToken != resumed.Response.ContinuationToken || effects.calls[StepRevokeSessions] != 1 {
		t.Fatalf("replayed Resume() = %#v, calls=%v, %v", replayed, effects.calls, err)
	}
	second, err := service.Resume(context.Background(), ResumeCommand{ContinuationToken: resumed.Response.ContinuationToken}, 1_200)
	if err != nil || second.Kind != ApplicationAccepted || effects.calls[StepCancelSubscription] != 1 {
		t.Fatalf("second Resume() = %#v, calls=%v, %v", second, effects.calls, err)
	}
	if len(effects.inputs) != 2 || effects.inputs[0].RequestedAt != 1_000 ||
		effects.inputs[0].ExecutedAt != 1_100 || effects.inputs[1].RequestedAt != 1_100 ||
		effects.inputs[1].ExecutedAt != 1_200 {
		t.Fatalf("effect timing = %#v", effects.inputs)
	}

	future, _ := CreateContinuationToken(credentials.bundle.Secret, 9)
	rejected, err := service.Resume(context.Background(), ResumeCommand{ContinuationToken: future}, 1_102)
	if err != nil || rejected.Kind != ApplicationRejected || rejected.Reason != ApplicationInvalidCapability {
		t.Fatalf("future Resume() = %#v, %v", rejected, err)
	}
}

func TestServiceRedactsEffectErrorsAndOmitsTerminalCapability(t *testing.T) {
	repository := &applicationRepository{}
	credentials := applicationCredentials(t)
	effects := &applicationEffects{err: errors.New("provider leaked a secret")}
	service := newApplicationService(t, repository, credentials, effects)
	scope := mustApplicationScope(t)
	operationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000002802")
	idempotencyKey, _ := ParseIdempotencyKey(strings.Repeat("J", 43))

	started, err := service.Start(context.Background(), scope, StartCommand{IdempotencyKey: idempotencyKey}, operationID, 2_000)
	if err != nil || started.Response == nil {
		t.Fatalf("Start() = %#v, %v", started, err)
	}
	result, err := service.Resume(context.Background(), ResumeCommand{ContinuationToken: started.Response.ContinuationToken}, 2_100)
	if err != nil || result.Kind != ApplicationAccepted || result.Response == nil || result.Response.Status != PublicRetryWait {
		t.Fatalf("retryable Start() = %#v, %v", result, err)
	}
	state, ok := repository.snapshot.Operation.State.(RetryWait)
	if !ok || state.FailureCode != "effect-unavailable" || strings.Contains(string(state.FailureCode), "secret") {
		t.Fatalf("stored failure = %#v", repository.snapshot.Operation.State)
	}

	terminalCode, _ := ParseFailureCode("policy-blocked")
	repository = &applicationRepository{}
	effects = &applicationEffects{result: StepEffectResult{Kind: EffectTerminalFailure, FailureCode: terminalCode}}
	service = newApplicationService(t, repository, credentials, effects)
	started, err = service.Start(context.Background(), scope, StartCommand{IdempotencyKey: idempotencyKey}, operationID, 3_000)
	if err != nil || started.Response == nil {
		t.Fatalf("terminal Start() = %#v, %v", started, err)
	}
	result, err = service.Resume(context.Background(), ResumeCommand{ContinuationToken: started.Response.ContinuationToken}, 3_100)
	if err != nil || result.Kind != ApplicationAccepted || result.Response == nil ||
		result.Response.Status != PublicFailed || result.Response.ContinuationToken != "" {
		t.Fatalf("terminal Start() = %#v, %v", result, err)
	}
}

func TestServiceRunsEveryOrderedEffectOnceAndReplaysTerminalResponse(t *testing.T) {
	repository := &applicationRepository{}
	credentials := applicationCredentials(t)
	effects := &applicationEffects{}
	service := newApplicationService(t, repository, credentials, effects)
	operationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000002803")
	idempotencyKey, _ := ParseIdempotencyKey(strings.Repeat("K", 43))
	result, err := service.Start(
		context.Background(), mustApplicationScope(t),
		StartCommand{IdempotencyKey: idempotencyKey}, operationID, 4_000,
	)
	if err != nil || result.Response == nil {
		t.Fatalf("Start() = %#v, %v", result, err)
	}
	var finalRequest ContinuationToken
	for index := range 5 {
		finalRequest = result.Response.ContinuationToken
		result, err = service.Resume(context.Background(), ResumeCommand{
			ContinuationToken: finalRequest,
		}, 4_100+int64(index*100))
		if err != nil || result.Kind != ApplicationAccepted || result.Response == nil {
			t.Fatalf("Resume(%d) = %#v, %v", index, result, err)
		}
	}
	if result.Response.Status != PublicCompleted || result.Response.ContinuationToken != "" {
		t.Fatalf("terminal response = %#v", result.Response)
	}
	for _, step := range orderedSteps {
		if effects.calls[step] != 1 {
			t.Fatalf("effect %s calls = %d", step, effects.calls[step])
		}
	}

	replayed, err := service.Resume(context.Background(), ResumeCommand{
		ContinuationToken: finalRequest,
	}, 4_601)
	if err != nil || replayed.Kind != ApplicationAccepted || replayed.Response == nil ||
		replayed.Response.Status != PublicCompleted || replayed.Response.ContinuationToken != "" {
		t.Fatalf("terminal replay = %#v, %v", replayed, err)
	}
	for _, step := range orderedSteps {
		if effects.calls[step] != 1 {
			t.Fatalf("replayed effect %s calls = %d", step, effects.calls[step])
		}
	}
}

func TestServiceRequiresCompleteDependencies(t *testing.T) {
	if _, err := NewService(ServiceOptions{}); !errors.Is(err, ErrInvalidServiceConfiguration) {
		t.Fatalf("NewService() error = %v", err)
	}
}

type applicationCredentialsPort struct {
	bundle CredentialBundle
}

func applicationCredentials(t *testing.T) *applicationCredentialsPort {
	t.Helper()
	idempotencyHash, _ := ParseCredentialHash(strings.Repeat("H", 43))
	secret, _ := ParseContinuationSecret(strings.Repeat("S", 43))
	secretHash, _ := ParseCredentialHash(strings.Repeat("D", 43))
	return &applicationCredentialsPort{bundle: CredentialBundle{
		IdempotencyHash: idempotencyHash, Secret: secret, SecretHash: secretHash,
	}}
}

func (port *applicationCredentialsPort) Derive(Scope, IdempotencyKey) (CredentialBundle, error) {
	return port.bundle, nil
}

func (port *applicationCredentialsPort) DigestSecret(secret ContinuationSecret) (CredentialHash, error) {
	if secret != port.bundle.Secret {
		return "", errors.New("unknown secret")
	}
	return port.bundle.SecretHash, nil
}

type applicationEffects struct {
	calls  map[Step]int
	inputs []StepEffectInput
	result StepEffectResult
	err    error
}

func (effects *applicationEffects) invoke(input StepEffectInput) (StepEffectResult, error) {
	if effects.calls == nil {
		effects.calls = make(map[Step]int)
	}
	effects.calls[input.Step]++
	effects.inputs = append(effects.inputs, input)
	if effects.err != nil {
		return StepEffectResult{}, effects.err
	}
	if effects.result.Kind != "" {
		return effects.result, nil
	}
	return StepEffectResult{Kind: EffectSucceeded}, nil
}

func (effects *applicationEffects) RevokeSessions(_ context.Context, input StepEffectInput) (StepEffectResult, error) {
	return effects.invoke(input)
}

func (effects *applicationEffects) CancelSubscriptionImmediately(_ context.Context, input StepEffectInput) (StepEffectResult, error) {
	return effects.invoke(input)
}

func (effects *applicationEffects) DeleteVaultData(_ context.Context, input StepEffectInput) (StepEffectResult, error) {
	return effects.invoke(input)
}

func (effects *applicationEffects) DeletePrivateObjects(_ context.Context, input StepEffectInput) (StepEffectResult, error) {
	return effects.invoke(input)
}

func (effects *applicationEffects) FinalizeAccount(_ context.Context, input StepEffectInput) (StepEffectResult, error) {
	return effects.invoke(input)
}

type applicationRepository struct {
	snapshot     Snapshot
	continuation Continuation
	started      bool
}

func (repository *applicationRepository) FindByOwner(_ context.Context, scope Scope) (*Snapshot, error) {
	if !repository.started || repository.snapshot.Operation.Scope != scope {
		return nil, nil
	}
	copy := repository.snapshot
	return &copy, nil
}

func (repository *applicationRepository) Start(_ context.Context, operation Operation, continuation Continuation) (StartResult, error) {
	if repository.started {
		if repository.continuation.IdempotencyHash != continuation.IdempotencyHash ||
			repository.continuation.SecretHash != continuation.SecretHash {
			return StartResult{Kind: StartRejected, Reason: StartCredentialConflict}, nil
		}
		return StartResult{Kind: StartExisting, AuthorizedSnapshot: AuthorizedSnapshot{
			Snapshot: repository.snapshot, Continuation: repository.continuation,
		}}, nil
	}
	repository.started = true
	repository.snapshot = Snapshot{Operation: operation}
	repository.continuation = continuation
	return StartResult{Kind: StartCreated, AuthorizedSnapshot: AuthorizedSnapshot{
		Snapshot: repository.snapshot, Continuation: repository.continuation,
	}}, nil
}

func (repository *applicationRepository) Consume(_ context.Context, secretHash CredentialHash, sequence int64, at int64) (ConsumeResult, error) {
	if !repository.started || secretHash != repository.continuation.SecretHash {
		return ConsumeResult{Kind: ConsumeRejected, Reason: ConsumeInvalidCapability}, nil
	}
	plan := PlanContinuationConsume(repository.continuation, sequence, at)
	switch plan.Kind {
	case ContinuationConsumeAdvance:
		repository.continuation = plan.Next
		return ConsumeResult{Kind: ConsumeConsumed, AuthorizedSnapshot: AuthorizedSnapshot{
			Snapshot: repository.snapshot, Continuation: repository.continuation,
		}}, nil
	case ContinuationConsumeReplay:
		return ConsumeResult{Kind: ConsumeReplayed, AuthorizedSnapshot: AuthorizedSnapshot{
			Snapshot: repository.snapshot, Continuation: repository.continuation,
		}}, nil
	default:
		reason := ConsumeInvalidCapability
		if plan.Reason == ContinuationExpired {
			reason = ConsumeExpired
		}
		return ConsumeResult{Kind: ConsumeRejected, Reason: reason}, nil
	}
}

func (repository *applicationRepository) Commit(_ context.Context, scope Scope, transition Transition) (CommitResult, error) {
	if scope != repository.snapshot.Operation.Scope || !ValidTransition(scope, transition) {
		return CommitResult{Kind: CommitRejected}, nil
	}
	if SameOperation(repository.snapshot.Operation, transition.Next) {
		copy := repository.snapshot
		return CommitResult{Kind: CommitReplayed, Current: &copy}, nil
	}
	if !SameOperation(repository.snapshot.Operation, transition.Current) {
		copy := repository.snapshot
		return CommitResult{Kind: CommitConflict, Current: &copy}, nil
	}
	repository.snapshot.Operation = transition.Next
	if transition.Receipt != nil {
		repository.snapshot.Receipts = append(repository.snapshot.Receipts, *transition.Receipt)
	}
	copy := repository.snapshot
	return CommitResult{Kind: CommitApplied, Current: &copy}, nil
}

func newApplicationService(
	t *testing.T,
	repository Repository,
	credentials CredentialPort,
	effects *applicationEffects,
) *Service {
	t.Helper()
	service, err := NewService(ServiceOptions{
		Repository: repository, Credentials: credentials,
		Sessions: effects, Subscriptions: effects, VaultData: effects,
		PrivateObjects: effects, Accounts: effects,
		ContinuationLifetime: 10_000, LeaseDuration: 100,
		RetryPolicy: RetryPolicy{DelaysMilli: []int64{50, 100}},
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func mustApplicationScope(t *testing.T) Scope {
	t.Helper()
	operation := mustStartOperation(t, 1_000)
	return operation.Scope
}
