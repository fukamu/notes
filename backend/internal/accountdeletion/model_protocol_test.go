package accountdeletion

import (
	"bytes"
	"errors"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

func TestAccountDeletionLifecycleReceiptsAndRetry(t *testing.T) {
	operation := mustStartOperation(t, 1_000)
	receipts := make([]Receipt, 0, len(orderedSteps))
	for index, step := range orderedSteps {
		startedAt := int64(1_100 + index*200)
		claim := PlanStepClaim(operation, startedAt, startedAt+100)
		if claim.Kind != PlanAccepted {
			t.Fatalf("claim %s = %#v", step, claim)
		}
		running, ok := claim.Transition.Next.State.(Running)
		if !ok || running.Step != step {
			t.Fatalf("running %s = %#v", step, claim.Transition.Next.State)
		}
		completed := PlanStepCompletion(claim.Transition.Next, StepResult{
			Kind: StepSucceeded, Step: step, Attempt: running.Attempt, FinishedAt: startedAt + 50,
		}, nil, RetryPolicy{})
		if completed.Kind != PlanAccepted || completed.Transition.Receipt == nil {
			t.Fatalf("complete %s = %#v", step, completed)
		}
		receipts = append(receipts, *completed.Transition.Receipt)
		operation = completed.Transition.Next
		if !ValidSnapshot(Snapshot{Operation: operation, Receipts: append([]Receipt(nil), receipts...)}) {
			t.Fatalf("snapshot after %s is invalid", step)
		}
	}
	if _, ok := operation.State.(Completed); !ok || len(receipts) != 5 {
		t.Fatalf("terminal operation = %#v; receipts = %d", operation, len(receipts))
	}

	operation = mustStartOperation(t, 2_000)
	claim := PlanStepClaim(operation, 2_100, 2_200)
	running := claim.Transition.Next.State.(Running)
	code, _ := ParseFailureCode("provider-unavailable")
	failed := PlanStepCompletion(claim.Transition.Next, StepResult{
		Kind: StepRetryableFailure, Step: running.Step, Attempt: running.Attempt,
		FinishedAt: 2_150, FailureCode: code,
	}, nil, RetryPolicy{DelaysMilli: []int64{100}})
	if failed.Kind != PlanAccepted {
		t.Fatalf("retryable failure = %#v", failed)
	}
	if early := PlanRetryResume(failed.Transition.Next, 2_249); early.Reason != ReasonNotReady {
		t.Fatalf("early retry = %#v", early)
	}
	resumed := PlanRetryResume(failed.Transition.Next, 2_250)
	reclaimed := PlanStepClaim(resumed.Transition.Next, 2_250, 2_350)
	running = reclaimed.Transition.Next.State.(Running)
	terminal := PlanStepCompletion(reclaimed.Transition.Next, StepResult{
		Kind: StepRetryableFailure, Step: running.Step, Attempt: running.Attempt,
		FinishedAt: 2_300, FailureCode: code,
	}, nil, RetryPolicy{DelaysMilli: []int64{100}})
	if terminal.Kind != PlanAccepted {
		t.Fatalf("retry exhaustion = %#v", terminal)
	}
	if _, ok := terminal.Transition.Next.State.(TerminalFailure); !ok {
		t.Fatalf("exhausted state = %#v", terminal.Transition.Next.State)
	}
}

func TestAccountDeletionExpiredLeaseAndInvalidSnapshotsFailClosed(t *testing.T) {
	operation := mustStartOperation(t, 3_000)
	claim := PlanStepClaim(operation, 3_100, 3_200)
	if early := PlanExpiredLeaseRecovery(claim.Transition.Next, 3_199, RetryPolicy{DelaysMilli: []int64{100}}); early.Reason != ReasonNotReady {
		t.Fatalf("early lease recovery = %#v", early)
	}
	recovered := PlanExpiredLeaseRecovery(claim.Transition.Next, 3_200, RetryPolicy{DelaysMilli: []int64{100}})
	state, ok := recovered.Transition.Next.State.(RetryWait)
	if recovered.Kind != PlanAccepted || !ok || state.RetryAt != 3_300 || state.FailureCode != "lease-expired" {
		t.Fatalf("expired lease recovery = %#v", recovered)
	}

	wrongScope := operation.Scope
	wrongScope.VaultID, _ = identity.ParseVaultID("01991f20-61d2-7000-8000-000000000202")
	if ValidTransition(wrongScope, claim.Transition) {
		t.Fatal("cross-owner transition was valid")
	}
	badReceipt := Receipt{OperationID: operation.OperationID, Step: StepCancelSubscription, CompletedAt: 3_150}
	if ValidSnapshot(Snapshot{Operation: operation, Receipts: []Receipt{badReceipt}}) {
		t.Fatal("non-prefix receipt was accepted")
	}
	bad := operation
	bad.State = RetryWait{Step: StepRevokeSessions, Attempt: 1, RetryAt: 3_100, FailureCode: "secret details!"}
	if ValidOperation(bad) {
		t.Fatal("sensitive failure detail was accepted")
	}
}

func TestEveryAccountDeletionStepCanRecoverRetryAndExpiredLease(t *testing.T) {
	for targetIndex, targetStep := range orderedSteps {
		t.Run(string(targetStep), func(t *testing.T) {
			operation, receipts := operationReadyAtStep(t, targetIndex, 5_000)
			claim := PlanStepClaim(operation, operation.UpdatedAt+10, operation.UpdatedAt+20)
			running := claim.Transition.Next.State.(Running)
			code, _ := ParseFailureCode("temporary-failure")
			failed := PlanStepCompletion(claim.Transition.Next, StepResult{
				Kind: StepRetryableFailure, Step: targetStep, Attempt: running.Attempt,
				FinishedAt: operation.UpdatedAt + 15, FailureCode: code,
			}, nil, RetryPolicy{DelaysMilli: []int64{25}})
			if failed.Kind != PlanAccepted {
				t.Fatalf("retry failure = %#v", failed)
			}
			retryAt := operation.UpdatedAt + 40
			resumed := PlanRetryResume(failed.Transition.Next, retryAt)
			if resumed.Kind != PlanAccepted || resumed.Transition.Next.State.(Ready).Step != targetStep ||
				!ValidSnapshot(Snapshot{Operation: resumed.Transition.Next, Receipts: receipts}) {
				t.Fatalf("retry resume = %#v", resumed)
			}

			recovered := PlanExpiredLeaseRecovery(
				claim.Transition.Next, operation.UpdatedAt+20,
				RetryPolicy{DelaysMilli: []int64{25}},
			)
			state, ok := recovered.Transition.Next.State.(RetryWait)
			if recovered.Kind != PlanAccepted || !ok || state.Step != targetStep ||
				!ValidSnapshot(Snapshot{Operation: recovered.Transition.Next, Receipts: receipts}) {
				t.Fatalf("lease recovery = %#v", recovered)
			}
		})
	}
}

func TestStepProgressReturnsReadyWithoutReceiptOrRetryAttempt(t *testing.T) {
	operation, receipts := operationReadyAtStep(t, 3, 3_500)
	claimed := PlanStepClaim(operation, 3_600, 3_700)
	running := claimed.Transition.Next.State.(Running)
	progressed := PlanStepCompletion(claimed.Transition.Next, StepResult{
		Kind: StepProgressed, Step: running.Step, Attempt: running.Attempt, FinishedAt: 3_650,
	}, nil, RetryPolicy{})
	state, ok := progressed.Transition.Next.State.(Ready)
	if progressed.Kind != PlanAccepted || !ok || state.Step != StepDeletePrivateObject ||
		state.Attempt != 0 || state.NotBefore != 3_650 || progressed.Transition.Receipt != nil ||
		!ValidSnapshot(Snapshot{Operation: progressed.Transition.Next, Receipts: receipts}) {
		t.Fatalf("progress completion = %#v", progressed)
	}
	reclaimed := PlanStepClaim(progressed.Transition.Next, 3_650, 3_750)
	if next := reclaimed.Transition.Next.State.(Running); next.Attempt != 1 || next.Step != StepDeletePrivateObject {
		t.Fatalf("progress reclaim = %#v", reclaimed)
	}
	code, _ := ParseFailureCode("not-a-progress-detail")
	if invalid := PlanStepCompletion(claimed.Transition.Next, StepResult{
		Kind: StepProgressed, Step: running.Step, Attempt: running.Attempt,
		FinishedAt: 3_650, FailureCode: code,
	}, nil, RetryPolicy{}); invalid.Reason != ReasonInvalidInput {
		t.Fatalf("progress with failure code = %#v", invalid)
	}
	receipt := Receipt{OperationID: operation.OperationID, Step: StepDeletePrivateObject, CompletedAt: 3_650}
	if invalid := PlanStepCompletion(claimed.Transition.Next, StepResult{
		Kind: StepProgressed, Step: running.Step, Attempt: running.Attempt, FinishedAt: 3_650,
	}, &receipt, RetryPolicy{}); invalid.Reason != ReasonReceiptMismatch {
		t.Fatalf("progress with receipt = %#v", invalid)
	}
	first := mustStartOperation(t, 3_500)
	firstClaim := PlanStepClaim(first, 3_600, 3_700)
	firstRunning := firstClaim.Transition.Next.State.(Running)
	if invalid := PlanStepCompletion(firstClaim.Transition.Next, StepResult{
		Kind: StepProgressed, Step: firstRunning.Step, Attempt: firstRunning.Attempt, FinishedAt: 3_650,
	}, nil, RetryPolicy{}); invalid.Reason != ReasonInvalidInput {
		t.Fatalf("non-private progress = %#v", invalid)
	}
	forged := Transition{
		Current: firstClaim.Transition.Next,
		Next: Operation{
			Scope: firstClaim.Transition.Next.Scope, OperationID: firstClaim.Transition.Next.OperationID,
			Revision:  firstClaim.Transition.Next.Revision + 1,
			State:     Ready{Step: StepRevokeSessions, Attempt: 0, NotBefore: 3_650},
			CreatedAt: firstClaim.Transition.Next.CreatedAt, UpdatedAt: 3_650,
		},
	}
	if ValidTransition(first.Scope, forged) {
		t.Fatal("non-private same-step reset transition was valid")
	}
}

func TestPrivateObjectProgressResetsTheNextFailureToRetryPolicyIndexZero(t *testing.T) {
	operation, receipts := operationReadyAtStep(t, 3, 6_000)
	policy := RetryPolicy{DelaysMilli: []int64{100, 1_000}}
	firstClaim := PlanStepClaim(operation, operation.UpdatedAt+10, operation.UpdatedAt+20)
	firstRunning := firstClaim.Transition.Next.State.(Running)
	code, _ := ParseFailureCode("storage-unavailable")
	firstFailure := PlanStepCompletion(firstClaim.Transition.Next, StepResult{
		Kind: StepRetryableFailure, Step: firstRunning.Step, Attempt: firstRunning.Attempt,
		FinishedAt: firstClaim.Transition.Next.UpdatedAt + 5, FailureCode: code,
	}, nil, policy)
	firstRetry := firstFailure.Transition.Next.State.(RetryWait)
	resumed := PlanRetryResume(firstFailure.Transition.Next, firstRetry.RetryAt)
	secondClaim := PlanStepClaim(resumed.Transition.Next, firstRetry.RetryAt, firstRetry.RetryAt+10)
	secondRunning := secondClaim.Transition.Next.State.(Running)
	if secondRunning.Attempt != 2 {
		t.Fatalf("second attempt = %d", secondRunning.Attempt)
	}
	progressed := PlanStepCompletion(secondClaim.Transition.Next, StepResult{
		Kind: StepProgressed, Step: secondRunning.Step, Attempt: secondRunning.Attempt,
		FinishedAt: secondClaim.Transition.Next.UpdatedAt + 5,
	}, nil, policy)
	if state := progressed.Transition.Next.State.(Ready); state.Attempt != 0 ||
		!ValidSnapshot(Snapshot{Operation: progressed.Transition.Next, Receipts: receipts}) {
		t.Fatalf("progress reset = %#v", progressed)
	}
	resetClaim := PlanStepClaim(
		progressed.Transition.Next, progressed.Transition.Next.UpdatedAt,
		progressed.Transition.Next.UpdatedAt+10,
	)
	resetRunning := resetClaim.Transition.Next.State.(Running)
	resetFailedAt := resetClaim.Transition.Next.UpdatedAt + 5
	resetFailure := PlanStepCompletion(resetClaim.Transition.Next, StepResult{
		Kind: StepRetryableFailure, Step: resetRunning.Step, Attempt: resetRunning.Attempt,
		FinishedAt: resetFailedAt, FailureCode: code,
	}, nil, policy)
	resetWait := resetFailure.Transition.Next.State.(RetryWait)
	if resetRunning.Attempt != 1 || resetWait.Attempt != 1 || resetWait.RetryAt != resetFailedAt+100 {
		t.Fatalf("reset failure = %#v", resetFailure)
	}
}

func TestContinuationSequenceAndRunPlanning(t *testing.T) {
	operation := mustStartOperation(t, 4_000)
	hashA, _ := ParseCredentialHash(strings.Repeat("H", 43))
	hashB, _ := ParseCredentialHash(strings.Repeat("S", 43))
	started := PlanContinuationStart(operation, hashA, hashB, 9_000)
	if started.Kind != ContinuationStartAccepted {
		t.Fatalf("continuation start = %#v", started)
	}
	consumed := PlanContinuationConsume(started.Continuation, 0, 4_100)
	if consumed.Kind != ContinuationConsumeAdvance || consumed.Next.Sequence != 1 {
		t.Fatalf("continuation consume = %#v", consumed)
	}
	if replay := PlanContinuationConsume(consumed.Next, 0, 4_101); replay.Kind != ContinuationConsumeReplay {
		t.Fatalf("continuation replay = %#v", replay)
	}
	if future := PlanContinuationConsume(consumed.Next, 3, 4_102); future.Reason != ContinuationInvalidCapability {
		t.Fatalf("future sequence = %#v", future)
	}
	if expired := PlanContinuationConsume(consumed.Next, 1, 9_000); expired.Reason != ContinuationExpired {
		t.Fatalf("expired continuation = %#v", expired)
	}

	snapshot := Snapshot{Operation: operation}
	run := PlanRun(snapshot, 4_100, 100, RetryPolicy{DelaysMilli: []int64{50}})
	if run.Kind != RunClaimStep {
		t.Fatalf("ready run = %#v", run)
	}
	running := Snapshot{Operation: run.Transition.Next}
	if waiting := PlanRun(running, 4_199, 100, RetryPolicy{DelaysMilli: []int64{50}}); waiting.Kind != RunReport {
		t.Fatalf("unexpired run = %#v", waiting)
	}
	if recovery := PlanRun(running, 4_200, 100, RetryPolicy{DelaysMilli: []int64{50}}); recovery.Kind != RunAdvanceState {
		t.Fatalf("expired run = %#v", recovery)
	}
}

func TestContinuationStartReplayRenewsOnlyExactPreEffectOperation(t *testing.T) {
	operation := mustStartOperation(t, 4_000)
	hashA, _ := ParseCredentialHash(strings.Repeat("H", 43))
	hashB, _ := ParseCredentialHash(strings.Repeat("S", 43))
	started := PlanContinuationStart(operation, hashA, hashB, 9_000)
	consumed := PlanContinuationConsume(started.Continuation, 0, 4_100)
	unexpiredOperationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000003002")
	unexpiredOperation := PlanStart(operation.Scope, unexpiredOperationID, 5_000)
	unexpiredRequested := PlanContinuationStart(unexpiredOperation.Operation, hashA, hashB, 10_000)
	unexpired := PlanContinuationStartReplay(
		Snapshot{Operation: operation}, consumed.Next, unexpiredRequested.Continuation,
	)
	if unexpired.Kind != ContinuationStartReplayUnchanged || unexpired.Continuation != consumed.Next {
		t.Fatalf("unexpired replay = %#v", unexpired)
	}
	requestedOperationID, _ := ParseOperationID("01991f20-61d2-7000-8000-000000003003")
	requestedOperation := PlanStart(operation.Scope, requestedOperationID, 10_000)
	requested := PlanContinuationStart(requestedOperation.Operation, hashA, hashB, 15_000)

	renewed := PlanContinuationStartReplay(
		Snapshot{Operation: operation}, consumed.Next, requested.Continuation,
	)
	if renewed.Kind != ContinuationStartReplayRenewed ||
		renewed.Continuation.OperationID != operation.OperationID ||
		renewed.Continuation.Sequence != consumed.Next.Sequence ||
		renewed.Continuation.ExpiresAt != requested.Continuation.ExpiresAt ||
		renewed.Continuation.UpdatedAt != requested.Continuation.CreatedAt {
		t.Fatalf("pre-effect renewal = %#v", renewed)
	}
	if replayed := PlanContinuationStartReplay(
		Snapshot{Operation: operation}, renewed.Continuation, requested.Continuation,
	); replayed.Kind != ContinuationStartReplayUnchanged || replayed.Continuation != renewed.Continuation {
		t.Fatalf("renewal replay = %#v", replayed)
	}

	claim := PlanStepClaim(operation, 10_100, 10_200)
	if rejected := PlanContinuationStartReplay(
		Snapshot{Operation: claim.Transition.Next}, consumed.Next, requested.Continuation,
	); rejected.Kind != ContinuationStartReplayRejected ||
		rejected.Reason != ContinuationStartReplayUnsafeState {
		t.Fatalf("post-claim renewal = %#v", rejected)
	}
	conflictingHash, _ := ParseCredentialHash(strings.Repeat("C", 43))
	conflicting := requested.Continuation
	conflicting.IdempotencyHash = conflictingHash
	if rejected := PlanContinuationStartReplay(
		Snapshot{Operation: operation}, consumed.Next, conflicting,
	); rejected.Kind != ContinuationStartReplayRejected ||
		rejected.Reason != ContinuationStartReplayCredentialConflict {
		t.Fatalf("conflicting renewal = %#v", rejected)
	}
}

func TestContinuationRecoveryPromotionRequiresRevocationClaim(t *testing.T) {
	operation := mustStartOperation(t, 4_000)
	hashA, _ := ParseCredentialHash(strings.Repeat("H", 43))
	hashB, _ := ParseCredentialHash(strings.Repeat("S", 43))
	started := PlanContinuationStart(operation, hashA, hashB, 9_000)
	consumed := PlanContinuationConsume(started.Continuation, 0, 4_100)
	claim := PlanStepClaim(operation, 4_200, 4_300)
	promotion := PlanContinuationRecoveryPromotion(consumed.Next, claim.Transition)
	if promotion.Kind != ContinuationRecoveryPromotionAccepted ||
		promotion.Next.ExpiresAt != identity.MaximumSafeInteger ||
		promotion.Next.UpdatedAt != claim.Transition.Next.UpdatedAt ||
		promotion.Next.Sequence != consumed.Next.Sequence {
		t.Fatalf("recovery promotion = %#v", promotion)
	}
	if !RequiresContinuationRecoveryPromotion(claim.Transition) {
		t.Fatal("revocation claim did not require recovery promotion")
	}

	cancelReady, _ := operationReadyAtStep(t, 1, 5_000)
	cancelClaim := PlanStepClaim(cancelReady, 5_100, 5_200)
	if rejected := PlanContinuationRecoveryPromotion(consumed.Next, cancelClaim.Transition); rejected.Kind != ContinuationRecoveryPromotionRejected ||
		rejected.Reason != ContinuationRecoveryInvalidClaim ||
		RequiresContinuationRecoveryPromotion(cancelClaim.Transition) {
		t.Fatalf("non-revocation promotion = %#v", rejected)
	}
}

func TestAccountDeletionStrictProtocol(t *testing.T) {
	key := strings.Repeat("I", 43)
	valid := []byte(`{"idempotencyKey":"` + key + `"}`)
	command, err := DecodeStartCommand(valid)
	if err != nil || command.IdempotencyKey == "" {
		t.Fatalf("DecodeStartCommand() = %#v, %v", command, err)
	}
	for _, candidate := range [][]byte{
		append(bytes.Clone(valid), []byte(` {}`)...),
		[]byte(`{"idempotencyKey":"` + key + `","idempotencyKey":"` + key + `"}`),
		[]byte(`{"idempotencyKey":"` + key + `","accountId":"hidden"}`),
		[]byte("{\"idempotencyKey\":\"\xff\"}"),
		[]byte(`{"idempotencyKey":"\ud800"}`),
	} {
		if _, err := DecodeStartCommand(candidate); !errors.Is(err, ErrInvalidRequest) {
			t.Fatalf("invalid start %q error = %v", candidate, err)
		}
	}
	secret := strings.Repeat("S", 43)
	token, err := ParseContinuationToken("ad1." + secret + ".2147483647")
	if err != nil {
		t.Fatal(err)
	}
	parsedSecret, sequence, err := ContinuationTokenParts(token)
	if err != nil || string(parsedSecret) != secret || sequence != MaximumRevision {
		t.Fatalf("token parts = %q, %d, %v", parsedSecret, sequence, err)
	}
	if _, err := ParseContinuationToken("ad1." + secret + ".2147483648"); !errors.Is(err, ErrInvalidRequest) {
		t.Fatalf("overflow sequence error = %v", err)
	}

	retry := []byte(`{"status":"retry-wait","retryAt":1e3,"continuationToken":"ad1.` + secret + `.1"}`)
	response, err := DecodePublicResponse(retry)
	if err != nil || response.RetryAt == nil || *response.RetryAt != 1_000 {
		t.Fatalf("retry response = %#v, %v", response, err)
	}
	if _, err := DecodePublicResponse([]byte(`{"status":"completed","continuationToken":"ad1.` + secret + `.1"}`)); !errors.Is(err, ErrInvalidPublicResponse) {
		t.Fatalf("terminal token error = %v", err)
	}
}

func mustStartOperation(t *testing.T, requestedAt int64) Operation {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	operationID, err := ParseOperationID("01991f20-61d2-7000-8000-000000003001")
	if err != nil {
		t.Fatal(err)
	}
	plan := PlanStart(Scope{AccountID: accountID, VaultID: vaultID}, operationID, requestedAt)
	if plan.Kind != PlanAccepted {
		t.Fatalf("PlanStart() = %#v", plan)
	}
	return plan.Operation
}

func operationReadyAtStep(t *testing.T, targetIndex int, requestedAt int64) (Operation, []Receipt) {
	t.Helper()
	operation := mustStartOperation(t, requestedAt)
	receipts := make([]Receipt, 0, targetIndex)
	for index := 0; index < targetIndex; index++ {
		startedAt := operation.UpdatedAt + 10
		claim := PlanStepClaim(operation, startedAt, startedAt+10)
		running := claim.Transition.Next.State.(Running)
		completed := PlanStepCompletion(claim.Transition.Next, StepResult{
			Kind: StepSucceeded, Step: running.Step, Attempt: running.Attempt,
			FinishedAt: startedAt + 5,
		}, nil, RetryPolicy{})
		if completed.Kind != PlanAccepted || completed.Transition.Receipt == nil {
			t.Fatalf("advance step %d = %#v", index, completed)
		}
		receipts = append(receipts, *completed.Transition.Receipt)
		operation = completed.Transition.Next
	}
	return operation, receipts
}
