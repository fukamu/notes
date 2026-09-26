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

func TestServiceAuthenticatedStartReplayRenewsOnlyBeforeRevocationClaim(t *testing.T) {
	repository := &applicationRepository{}
	credentials := applicationCredentials(t)
	effects := &applicationEffects{}
	service := newApplicationService(t, repository, credentials, effects)
	scope := mustApplicationScope(t)
	idempotencyKey, _ := ParseIdempotencyKey(strings.Repeat("R", 43))
	initialOperationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000002811")
	started, err := service.Start(
		context.Background(), scope, StartCommand{IdempotencyKey: idempotencyKey},
		initialOperationID, 1_000,
	)
	if err != nil || started.Response == nil {
		t.Fatalf("initial Start() = %#v, %v", started, err)
	}
	unexpiredOperationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000002812")
	unexpired, err := service.Start(
		context.Background(), scope, StartCommand{IdempotencyKey: idempotencyKey},
		unexpiredOperationID, 2_000,
	)
	if err != nil || unexpired.Kind != ApplicationAccepted || unexpired.Response == nil ||
		repository.continuation.ExpiresAt != 11_000 {
		t.Fatalf("unexpired replay Start() = %#v continuation=%#v, %v",
			unexpired, repository.continuation, err)
	}
	if expired, resumeErr := service.Resume(
		context.Background(), ResumeCommand{ContinuationToken: started.Response.ContinuationToken}, 11_000,
	); resumeErr != nil || expired.Kind != ApplicationRejected || expired.Reason != ApplicationInvalidCapability {
		t.Fatalf("expired Resume() = %#v, %v", expired, resumeErr)
	}

	replayOperationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000002813")
	renewed, err := service.Start(
		context.Background(), scope, StartCommand{IdempotencyKey: idempotencyKey},
		replayOperationID, 12_000,
	)
	if err != nil || renewed.Kind != ApplicationAccepted || renewed.Response == nil ||
		renewed.Response.ContinuationToken != started.Response.ContinuationToken ||
		repository.continuation.ExpiresAt != 22_000 || effects.calls[StepRevokeSessions] != 0 {
		t.Fatalf("renewed Start() = %#v continuation=%#v calls=%v, %v",
			renewed, repository.continuation, effects.calls, err)
	}
	lostResponseOperationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000002814")
	lostResponseReplay, err := service.Start(
		context.Background(), scope, StartCommand{IdempotencyKey: idempotencyKey},
		lostResponseOperationID, 12_001,
	)
	if err != nil || lostResponseReplay.Kind != ApplicationAccepted ||
		lostResponseReplay.Response == nil || repository.continuation.ExpiresAt != 22_000 {
		t.Fatalf("lost renewal replay Start() = %#v continuation=%#v, %v",
			lostResponseReplay, repository.continuation, err)
	}
	resumed, err := service.Resume(
		context.Background(), ResumeCommand{ContinuationToken: renewed.Response.ContinuationToken}, 12_001,
	)
	if err != nil || resumed.Kind != ApplicationAccepted || effects.calls[StepRevokeSessions] != 1 {
		t.Fatalf("renewed Resume() = %#v calls=%v, %v", resumed, effects.calls, err)
	}
	persistedExpiry := repository.continuation.ExpiresAt
	postClaimReplayID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000002815")
	postClaimReplay, err := service.Start(
		context.Background(), scope, StartCommand{IdempotencyKey: idempotencyKey},
		postClaimReplayID, 13_000,
	)
	if err != nil || postClaimReplay.Kind != ApplicationAccepted || postClaimReplay.Response == nil ||
		repository.continuation.ExpiresAt != persistedExpiry || effects.calls[StepRevokeSessions] != 1 {
		t.Fatalf("unexpired post-claim Start() = %#v continuation=%#v calls=%v, %v",
			postClaimReplay, repository.continuation, effects.calls, err)
	}
	unsafeOperationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000002816")
	unsafe, err := service.Start(
		context.Background(), scope, StartCommand{IdempotencyKey: idempotencyKey},
		unsafeOperationID, 23_000,
	)
	if err != nil || unsafe.Kind != ApplicationRejected || unsafe.Reason != ApplicationUnavailable ||
		repository.continuation.ExpiresAt != persistedExpiry || effects.calls[StepRevokeSessions] != 1 {
		t.Fatalf("expired post-claim Start() = %#v continuation=%#v calls=%v, %v",
			unsafe, repository.continuation, effects.calls, err)
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

func TestServiceProgressRepeatsTheStepWithoutConsumingRetryBudgetOrWritingReceipt(t *testing.T) {
	repository := &applicationRepository{}
	credentials := applicationCredentials(t)
	effects := &applicationEffects{results: []StepEffectResult{
		{Kind: EffectSucceeded},
		{Kind: EffectSucceeded},
		{Kind: EffectSucceeded},
		{Kind: EffectProgressed},
		{Kind: EffectSucceeded},
	}}
	service := newApplicationService(t, repository, credentials, effects)
	operationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000002804")
	idempotencyKey, _ := ParseIdempotencyKey(strings.Repeat("L", 43))
	started, err := service.Start(
		context.Background(), mustApplicationScope(t),
		StartCommand{IdempotencyKey: idempotencyKey}, operationID, 5_000,
	)
	if err != nil || started.Response == nil {
		t.Fatalf("Start() = %#v, %v", started, err)
	}
	result := started
	for index := range 3 {
		result, err = service.Resume(context.Background(), ResumeCommand{
			ContinuationToken: result.Response.ContinuationToken,
		}, 5_100+int64(index*100))
		if err != nil || result.Response == nil {
			t.Fatalf("advance Resume(%d) = %#v, %v", index, result, err)
		}
	}
	progressed, err := service.Resume(context.Background(), ResumeCommand{
		ContinuationToken: result.Response.ContinuationToken,
	}, 5_400)
	if err != nil || progressed.Response == nil || progressed.Response.Status != PublicInProgress {
		t.Fatalf("progress Resume() = %#v, %v", progressed, err)
	}
	state, ok := repository.snapshot.Operation.State.(Ready)
	if !ok || state.Step != StepDeletePrivateObject || state.Attempt != 0 || state.NotBefore != 5_400 ||
		len(repository.snapshot.Receipts) != 3 {
		t.Fatalf("progress snapshot = %#v", repository.snapshot)
	}
	completed, err := service.Resume(context.Background(), ResumeCommand{
		ContinuationToken: progressed.Response.ContinuationToken,
	}, 5_500)
	if err != nil || completed.Response == nil || effects.calls[StepDeletePrivateObject] != 2 {
		t.Fatalf("completed Resume() = %#v, calls=%v, %v", completed, effects.calls, err)
	}
	state, ok = repository.snapshot.Operation.State.(Ready)
	if !ok || state.Step != StepFinalizeAccount || state.Attempt != 0 ||
		len(repository.snapshot.Receipts) != 4 || repository.snapshot.Receipts[3].Step != StepDeletePrivateObject {
		t.Fatalf("completed snapshot = %#v", repository.snapshot)
	}
	replayed, err := service.Resume(context.Background(), ResumeCommand{
		ContinuationToken: progressed.Response.ContinuationToken,
	}, 5_501)
	if err != nil || replayed.Response == nil || effects.calls[StepDeletePrivateObject] != 2 {
		t.Fatalf("replay Resume() = %#v, calls=%v, %v", replayed, effects.calls, err)
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
	calls   map[Step]int
	inputs  []StepEffectInput
	results []StepEffectResult
	result  StepEffectResult
	err     error
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
	if len(effects.results) != 0 {
		result := effects.results[0]
		effects.results = effects.results[1:]
		return result, nil
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
		plan := PlanContinuationStartReplay(repository.snapshot, repository.continuation, continuation)
		if plan.Kind == ContinuationStartReplayRejected {
			if plan.Reason != ContinuationStartReplayCredentialConflict {
				return StartResult{Kind: StartRejected, Reason: StartInvalid}, nil
			}
			return StartResult{Kind: StartRejected, Reason: StartCredentialConflict}, nil
		}
		repository.continuation = plan.Continuation
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
