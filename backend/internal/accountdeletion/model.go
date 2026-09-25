package accountdeletion

import "github.com/fukamu/notes/backend/internal/identity"

const (
	MaximumRevision int64 = 2_147_483_647
	MaximumAttempt  int64 = 1_000
)

type Step string

const (
	StepRevokeSessions      Step = "revoke-sessions"
	StepCancelSubscription  Step = "cancel-subscription"
	StepDeleteVaultData     Step = "delete-vault-data"
	StepDeletePrivateObject Step = "delete-private-objects"
	StepFinalizeAccount     Step = "finalize-account"
)

var orderedSteps = [...]Step{
	StepRevokeSessions,
	StepCancelSubscription,
	StepDeleteVaultData,
	StepDeletePrivateObject,
	StepFinalizeAccount,
}

type StateKind string

const (
	StateReady           StateKind = "ready"
	StateRunning         StateKind = "running"
	StateRetryWait       StateKind = "retry-wait"
	StateTerminalFailure StateKind = "terminal-failure"
	StateCompleted       StateKind = "completed"
)

type Scope struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
}

type State interface {
	accountDeletionState()
	Kind() StateKind
}

type Ready struct {
	Step      Step
	Attempt   int64
	NotBefore int64
}

func (Ready) accountDeletionState() {}
func (Ready) Kind() StateKind       { return StateReady }

type Running struct {
	Step           Step
	Attempt        int64
	LeaseExpiresAt int64
}

func (Running) accountDeletionState() {}
func (Running) Kind() StateKind       { return StateRunning }

type RetryWait struct {
	Step        Step
	Attempt     int64
	RetryAt     int64
	FailureCode FailureCode
}

func (RetryWait) accountDeletionState() {}
func (RetryWait) Kind() StateKind       { return StateRetryWait }

type TerminalFailure struct {
	Step        Step
	Attempt     int64
	FailureCode FailureCode
}

func (TerminalFailure) accountDeletionState() {}
func (TerminalFailure) Kind() StateKind       { return StateTerminalFailure }

type Completed struct {
	CompletedAt int64
}

func (Completed) accountDeletionState() {}
func (Completed) Kind() StateKind       { return StateCompleted }

type Operation struct {
	Scope       Scope
	OperationID OperationID
	Revision    int64
	State       State
	CreatedAt   int64
	UpdatedAt   int64
}

type Receipt struct {
	OperationID OperationID
	Step        Step
	CompletedAt int64
}

type Snapshot struct {
	Operation Operation
	Receipts  []Receipt
}

type Transition struct {
	Current Operation
	Next    Operation
	Receipt *Receipt
}

type RetryPolicy struct {
	DelaysMilli []int64
}

type PlanKind string
type PlanReason string

const (
	PlanAccepted PlanKind = "accepted"
	PlanReplayed PlanKind = "replayed"
	PlanRejected PlanKind = "rejected"

	ReasonAttemptLimit    PlanReason = "attempt-limit"
	ReasonInvalidLease    PlanReason = "invalid-lease"
	ReasonInvalidPolicy   PlanReason = "invalid-policy"
	ReasonInvalidInput    PlanReason = "invalid-input"
	ReasonInvalidTime     PlanReason = "invalid-timestamp"
	ReasonNotReady        PlanReason = "not-ready"
	ReasonReceiptMismatch PlanReason = "receipt-mismatch"
	ReasonRevisionLimit   PlanReason = "revision-limit"
	ReasonStepMismatch    PlanReason = "step-mismatch"
	ReasonWrongState      PlanReason = "wrong-state"
)

type Plan struct {
	Kind       PlanKind
	Reason     PlanReason
	Operation  Operation
	Transition Transition
}

type StepResultKind string

const (
	StepSucceeded        StepResultKind = "succeeded"
	StepRetryableFailure StepResultKind = "retryable-failure"
	StepTerminalFailure  StepResultKind = "terminal-failure"
)

type StepResult struct {
	Kind        StepResultKind
	Step        Step
	Attempt     int64
	FinishedAt  int64
	FailureCode FailureCode
}

func PlanStart(scope Scope, operationID OperationID, requestedAt int64) Plan {
	operation := Operation{
		Scope: scope, OperationID: operationID, Revision: 1,
		State:     Ready{Step: StepRevokeSessions, Attempt: 0, NotBefore: requestedAt},
		CreatedAt: requestedAt, UpdatedAt: requestedAt,
	}
	if !InitialOperation(operation) {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidInput}
	}
	return Plan{Kind: PlanAccepted, Operation: operation}
}

func PlanStepClaim(operation Operation, startedAt, leaseExpiresAt int64) Plan {
	state, ok := operation.State.(Ready)
	if !ok {
		return Plan{Kind: PlanRejected, Reason: ReasonWrongState}
	}
	if !validTimestamp(startedAt) || startedAt < operation.UpdatedAt {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidTime}
	}
	if startedAt < state.NotBefore {
		return Plan{Kind: PlanRejected, Reason: ReasonNotReady}
	}
	if !validTimestamp(leaseExpiresAt) || leaseExpiresAt <= startedAt {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidLease}
	}
	if state.Attempt >= MaximumAttempt {
		return Plan{Kind: PlanRejected, Reason: ReasonAttemptLimit}
	}
	return advance(operation, Running{
		Step: state.Step, Attempt: state.Attempt + 1, LeaseExpiresAt: leaseExpiresAt,
	}, startedAt, nil)
}

func PlanStepCompletion(
	operation Operation,
	result StepResult,
	existingReceipt *Receipt,
	policy RetryPolicy,
) Plan {
	if existingReceipt != nil {
		state, running := operation.State.(Running)
		if existingReceipt.OperationID != operation.OperationID || existingReceipt.Step != result.Step ||
			result.Kind != StepSucceeded || (running && state.Step == result.Step) {
			return Plan{Kind: PlanRejected, Reason: ReasonReceiptMismatch}
		}
		return Plan{Kind: PlanReplayed, Operation: operation}
	}
	state, ok := operation.State.(Running)
	if !ok {
		return Plan{Kind: PlanRejected, Reason: ReasonWrongState}
	}
	if state.Step != result.Step || state.Attempt != result.Attempt {
		return Plan{Kind: PlanRejected, Reason: ReasonStepMismatch}
	}
	if !validTimestamp(result.FinishedAt) || result.FinishedAt < operation.UpdatedAt {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidTime}
	}
	switch result.Kind {
	case StepSucceeded:
		return planSuccess(operation, state, result.FinishedAt)
	case StepRetryableFailure:
		if _, err := ParseFailureCode(string(result.FailureCode)); err != nil {
			return Plan{Kind: PlanRejected, Reason: ReasonInvalidInput}
		}
		return planFailure(operation, state, result.FinishedAt, result.FailureCode, policy, true)
	case StepTerminalFailure:
		if _, err := ParseFailureCode(string(result.FailureCode)); err != nil {
			return Plan{Kind: PlanRejected, Reason: ReasonInvalidInput}
		}
		return planFailure(operation, state, result.FinishedAt, result.FailureCode, policy, false)
	default:
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidInput}
	}
}

func PlanRetryResume(operation Operation, resumedAt int64) Plan {
	state, ok := operation.State.(RetryWait)
	if !ok {
		return Plan{Kind: PlanRejected, Reason: ReasonWrongState}
	}
	if !validTimestamp(resumedAt) || resumedAt < operation.UpdatedAt {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidTime}
	}
	if resumedAt < state.RetryAt {
		return Plan{Kind: PlanRejected, Reason: ReasonNotReady}
	}
	return advance(operation, Ready{
		Step: state.Step, Attempt: state.Attempt, NotBefore: resumedAt,
	}, resumedAt, nil)
}

func PlanExpiredLeaseRecovery(operation Operation, recoveredAt int64, policy RetryPolicy) Plan {
	state, ok := operation.State.(Running)
	if !ok {
		return Plan{Kind: PlanRejected, Reason: ReasonWrongState}
	}
	if !validTimestamp(recoveredAt) || recoveredAt < operation.UpdatedAt {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidTime}
	}
	if recoveredAt < state.LeaseExpiresAt {
		return Plan{Kind: PlanRejected, Reason: ReasonNotReady}
	}
	code, _ := ParseFailureCode("lease-expired")
	return planFailure(operation, state, recoveredAt, code, policy, true)
}

func planSuccess(operation Operation, state Running, completedAt int64) Plan {
	receipt := &Receipt{OperationID: operation.OperationID, Step: state.Step, CompletedAt: completedAt}
	next, ok := nextStep(state.Step)
	if !ok {
		return advance(operation, Completed{CompletedAt: completedAt}, completedAt, receipt)
	}
	return advance(operation, Ready{Step: next, Attempt: 0, NotBefore: completedAt}, completedAt, receipt)
}

func planFailure(
	operation Operation,
	state Running,
	failedAt int64,
	failureCode FailureCode,
	policy RetryPolicy,
	retryable bool,
) Plan {
	if !retryable {
		return advance(operation, TerminalFailure{
			Step: state.Step, Attempt: state.Attempt, FailureCode: failureCode,
		}, failedAt, nil)
	}
	if !ValidRetryPolicy(policy) {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidPolicy}
	}
	index := state.Attempt - 1
	if index < 0 || index >= int64(len(policy.DelaysMilli)) {
		return advance(operation, TerminalFailure{
			Step: state.Step, Attempt: state.Attempt, FailureCode: failureCode,
		}, failedAt, nil)
	}
	delay := policy.DelaysMilli[index]
	if delay > identity.MaximumSafeInteger-failedAt {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidPolicy}
	}
	return advance(operation, RetryWait{
		Step: state.Step, Attempt: state.Attempt, RetryAt: failedAt + delay,
		FailureCode: failureCode,
	}, failedAt, nil)
}

func advance(current Operation, state State, updatedAt int64, receipt *Receipt) Plan {
	if current.Revision >= MaximumRevision {
		return Plan{Kind: PlanRejected, Reason: ReasonRevisionLimit}
	}
	next := current
	next.Revision++
	next.State = state
	next.UpdatedAt = updatedAt
	transition := Transition{Current: current, Next: next, Receipt: receipt}
	if !ValidTransition(current.Scope, transition) {
		return Plan{Kind: PlanRejected, Reason: ReasonWrongState}
	}
	return Plan{Kind: PlanAccepted, Transition: transition}
}

func ValidScope(scope Scope) bool {
	_, accountErr := identity.ParseAccountID(string(scope.AccountID))
	_, vaultErr := identity.ParseVaultID(string(scope.VaultID))
	return accountErr == nil && vaultErr == nil
}

func ValidStep(step Step) bool {
	_, ok := stepIndex(step)
	return ok
}

func ValidRetryPolicy(policy RetryPolicy) bool {
	if len(policy.DelaysMilli) > 10 {
		return false
	}
	for _, delay := range policy.DelaysMilli {
		if !validTimestamp(delay) {
			return false
		}
	}
	return true
}

func ValidOperation(operation Operation) bool {
	if !ValidScope(operation.Scope) || operation.State == nil || operation.Revision < 1 ||
		operation.Revision > MaximumRevision || !validTimestamp(operation.CreatedAt) ||
		!validTimestamp(operation.UpdatedAt) || operation.UpdatedAt < operation.CreatedAt {
		return false
	}
	if _, err := ParseOperationID(string(operation.OperationID)); err != nil {
		return false
	}
	switch state := operation.State.(type) {
	case Ready:
		return ValidStep(state.Step) && validAttempt(state.Attempt) &&
			state.NotBefore >= operation.UpdatedAt && validTimestamp(state.NotBefore)
	case Running:
		return ValidStep(state.Step) && state.Attempt > 0 && validAttempt(state.Attempt) &&
			state.LeaseExpiresAt > operation.UpdatedAt && validTimestamp(state.LeaseExpiresAt)
	case RetryWait:
		_, codeErr := ParseFailureCode(string(state.FailureCode))
		return codeErr == nil && ValidStep(state.Step) && state.Attempt > 0 && validAttempt(state.Attempt) &&
			state.RetryAt >= operation.UpdatedAt && validTimestamp(state.RetryAt)
	case TerminalFailure:
		_, codeErr := ParseFailureCode(string(state.FailureCode))
		return codeErr == nil && ValidStep(state.Step) && state.Attempt > 0 && validAttempt(state.Attempt)
	case Completed:
		return validTimestamp(state.CompletedAt) && state.CompletedAt == operation.UpdatedAt
	default:
		return false
	}
}

func InitialOperation(operation Operation) bool {
	state, ok := operation.State.(Ready)
	return ok && ValidOperation(operation) && operation.Revision == 1 &&
		operation.CreatedAt == operation.UpdatedAt && state.Step == StepRevokeSessions &&
		state.Attempt == 0 && state.NotBefore == operation.CreatedAt
}

func ValidTransition(scope Scope, transition Transition) bool {
	current, next := transition.Current, transition.Next
	if !ValidOperation(current) || !ValidOperation(next) || current.Scope != scope || next.Scope != scope ||
		!sameIdentity(current, next) || next.Revision != current.Revision+1 || next.UpdatedAt < current.UpdatedAt {
		return false
	}
	switch currentState := current.State.(type) {
	case Ready:
		nextState, ok := next.State.(Running)
		return ok && transition.Receipt == nil && nextState.Step == currentState.Step &&
			nextState.Attempt == currentState.Attempt+1 && next.UpdatedAt >= currentState.NotBefore &&
			nextState.LeaseExpiresAt > next.UpdatedAt
	case Running:
		switch nextState := next.State.(type) {
		case RetryWait:
			return transition.Receipt == nil && sameActiveStep(currentState, nextState.Step, nextState.Attempt) &&
				nextState.RetryAt >= next.UpdatedAt
		case TerminalFailure:
			return transition.Receipt == nil && sameActiveStep(currentState, nextState.Step, nextState.Attempt)
		case Ready:
			following, hasFollowing := nextStep(currentState.Step)
			return hasFollowing && following == nextState.Step && nextState.Attempt == 0 &&
				nextState.NotBefore == next.UpdatedAt && validSuccessReceipt(current, next, transition.Receipt)
		case Completed:
			return currentState.Step == StepFinalizeAccount && nextState.CompletedAt == next.UpdatedAt &&
				validSuccessReceipt(current, next, transition.Receipt)
		}
	case RetryWait:
		nextState, ok := next.State.(Ready)
		return ok && transition.Receipt == nil && nextState.Step == currentState.Step &&
			nextState.Attempt == currentState.Attempt && nextState.NotBefore == next.UpdatedAt &&
			next.UpdatedAt >= currentState.RetryAt
	}
	return false
}

func ValidSnapshot(snapshot Snapshot) bool {
	operation := snapshot.Operation
	if !ValidOperation(operation) || len(snapshot.Receipts) > len(orderedSteps) {
		return false
	}
	previous := operation.CreatedAt
	for index, receipt := range snapshot.Receipts {
		if receipt.OperationID != operation.OperationID || receipt.Step != orderedSteps[index] ||
			!validTimestamp(receipt.CompletedAt) || receipt.CompletedAt < previous ||
			receipt.CompletedAt > operation.UpdatedAt {
			return false
		}
		previous = receipt.CompletedAt
	}
	if _, completed := operation.State.(Completed); completed {
		return len(snapshot.Receipts) == len(orderedSteps)
	}
	step, ok := activeStep(operation.State)
	return ok && len(snapshot.Receipts) < len(orderedSteps) && step == orderedSteps[len(snapshot.Receipts)]
}

func SameOperation(left, right Operation) bool {
	return sameIdentity(left, right) && left.Revision == right.Revision &&
		left.UpdatedAt == right.UpdatedAt && sameState(left.State, right.State)
}

func SameReceipt(left, right Receipt) bool { return left == right }

func sameIdentity(left, right Operation) bool {
	return left.Scope == right.Scope && left.OperationID == right.OperationID && left.CreatedAt == right.CreatedAt
}

func sameState(left, right State) bool {
	switch leftState := left.(type) {
	case Ready:
		rightState, ok := right.(Ready)
		return ok && leftState == rightState
	case Running:
		rightState, ok := right.(Running)
		return ok && leftState == rightState
	case RetryWait:
		rightState, ok := right.(RetryWait)
		return ok && leftState == rightState
	case TerminalFailure:
		rightState, ok := right.(TerminalFailure)
		return ok && leftState == rightState
	case Completed:
		rightState, ok := right.(Completed)
		return ok && leftState == rightState
	default:
		return false
	}
}

func validSuccessReceipt(current, next Operation, receipt *Receipt) bool {
	state, ok := current.State.(Running)
	return ok && receipt != nil && receipt.OperationID == current.OperationID &&
		receipt.Step == state.Step && receipt.CompletedAt == next.UpdatedAt
}

func sameActiveStep(state Running, step Step, attempt int64) bool {
	return state.Step == step && state.Attempt == attempt
}

func activeStep(state State) (Step, bool) {
	switch value := state.(type) {
	case Ready:
		return value.Step, true
	case Running:
		return value.Step, true
	case RetryWait:
		return value.Step, true
	case TerminalFailure:
		return value.Step, true
	default:
		return "", false
	}
}

func stepIndex(step Step) (int, bool) {
	for index, candidate := range orderedSteps {
		if candidate == step {
			return index, true
		}
	}
	return 0, false
}

func nextStep(step Step) (Step, bool) {
	index, ok := stepIndex(step)
	if !ok || index+1 >= len(orderedSteps) {
		return "", false
	}
	return orderedSteps[index+1], true
}

func validAttempt(value int64) bool { return value >= 0 && value <= MaximumAttempt }
func validTimestamp(value int64) bool {
	return value >= 0 && value <= identity.MaximumSafeInteger
}
