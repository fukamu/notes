package accountdeletion

import "github.com/fukamu/notes/backend/internal/identity"

type Continuation struct {
	OperationID     OperationID
	IdempotencyHash CredentialHash
	SecretHash      CredentialHash
	Sequence        int64
	ExpiresAt       int64
	CreatedAt       int64
	UpdatedAt       int64
}

type ContinuationStartKind string
type ContinuationStartReason string

const (
	ContinuationStartAccepted ContinuationStartKind = "accepted"
	ContinuationStartRejected ContinuationStartKind = "rejected"

	ContinuationInvalidExpiry    ContinuationStartReason = "invalid-expiry"
	ContinuationInvalidOperation ContinuationStartReason = "invalid-operation"
)

type ContinuationStartPlan struct {
	Kind         ContinuationStartKind
	Reason       ContinuationStartReason
	Continuation Continuation
}

func PlanContinuationStart(
	operation Operation,
	idempotencyHash CredentialHash,
	secretHash CredentialHash,
	expiresAt int64,
) ContinuationStartPlan {
	if !InitialOperation(operation) {
		return ContinuationStartPlan{Kind: ContinuationStartRejected, Reason: ContinuationInvalidOperation}
	}
	if _, err := ParseCredentialHash(string(idempotencyHash)); err != nil {
		return ContinuationStartPlan{Kind: ContinuationStartRejected, Reason: ContinuationInvalidOperation}
	}
	if _, err := ParseCredentialHash(string(secretHash)); err != nil {
		return ContinuationStartPlan{Kind: ContinuationStartRejected, Reason: ContinuationInvalidOperation}
	}
	if !validTimestamp(expiresAt) || expiresAt <= operation.CreatedAt {
		return ContinuationStartPlan{Kind: ContinuationStartRejected, Reason: ContinuationInvalidExpiry}
	}
	continuation := Continuation{
		OperationID: operation.OperationID, IdempotencyHash: idempotencyHash,
		SecretHash: secretHash, Sequence: 0, ExpiresAt: expiresAt,
		CreatedAt: operation.CreatedAt, UpdatedAt: operation.CreatedAt,
	}
	if !ValidContinuation(continuation) {
		return ContinuationStartPlan{Kind: ContinuationStartRejected, Reason: ContinuationInvalidOperation}
	}
	return ContinuationStartPlan{Kind: ContinuationStartAccepted, Continuation: continuation}
}

type ContinuationStartReplayKind string
type ContinuationStartReplayReason string

const (
	ContinuationStartReplayUnchanged ContinuationStartReplayKind = "unchanged"
	ContinuationStartReplayRenewed   ContinuationStartReplayKind = "renewed"
	ContinuationStartReplayRejected  ContinuationStartReplayKind = "rejected"

	ContinuationStartReplayCredentialConflict ContinuationStartReplayReason = "credential-conflict"
	ContinuationStartReplayInvalid            ContinuationStartReplayReason = "invalid-replay"
	ContinuationStartReplayUnsafeState        ContinuationStartReplayReason = "unsafe-state"
)

type ContinuationStartReplayPlan struct {
	Kind         ContinuationStartReplayKind
	Reason       ContinuationStartReplayReason
	Continuation Continuation
}

// PlanContinuationStartReplay keeps ordinary idempotent Start replay
// read-only. It may extend the existing credential only while the operation is
// still the exact pre-effect initial state. This closes the crash window where
// a browser persisted revoke-pending but did not claim session revocation
// before the initial credential expired; once any step is claimed or receipted,
// Start is never a renewal authority.
func PlanContinuationStartReplay(
	snapshot Snapshot,
	current Continuation,
	requested Continuation,
) ContinuationStartReplayPlan {
	if !ValidSnapshot(snapshot) || !ValidContinuation(current) || !ValidContinuation(requested) ||
		current.OperationID != snapshot.Operation.OperationID {
		return ContinuationStartReplayPlan{
			Kind: ContinuationStartReplayRejected, Reason: ContinuationStartReplayInvalid,
		}
	}
	if current.IdempotencyHash != requested.IdempotencyHash || current.SecretHash != requested.SecretHash {
		return ContinuationStartReplayPlan{
			Kind: ContinuationStartReplayRejected, Reason: ContinuationStartReplayCredentialConflict,
		}
	}
	// An ordinary replay before the exclusive expiry boundary is read-only;
	// repeated Start requests must not turn the initial seven-day window into a
	// sliding lease.
	if requested.CreatedAt < current.ExpiresAt {
		return ContinuationStartReplayPlan{
			Kind: ContinuationStartReplayUnchanged, Continuation: current,
		}
	}
	if !InitialOperation(snapshot.Operation) || len(snapshot.Receipts) != 0 {
		return ContinuationStartReplayPlan{
			Kind: ContinuationStartReplayRejected, Reason: ContinuationStartReplayUnsafeState,
		}
	}
	if requested.ExpiresAt <= current.ExpiresAt {
		return ContinuationStartReplayPlan{
			Kind: ContinuationStartReplayRejected, Reason: ContinuationStartReplayInvalid,
		}
	}
	next := current
	next.ExpiresAt = requested.ExpiresAt
	if requested.CreatedAt > next.UpdatedAt {
		next.UpdatedAt = requested.CreatedAt
	}
	if !ValidContinuation(next) {
		return ContinuationStartReplayPlan{
			Kind: ContinuationStartReplayRejected, Reason: ContinuationStartReplayInvalid,
		}
	}
	return ContinuationStartReplayPlan{
		Kind: ContinuationStartReplayRenewed, Continuation: next,
	}
}

type ContinuationConsumeKind string
type ContinuationConsumeReason string

const (
	ContinuationConsumeAdvance  ContinuationConsumeKind = "consume"
	ContinuationConsumeReplay   ContinuationConsumeKind = "replay"
	ContinuationConsumeRejected ContinuationConsumeKind = "rejected"

	ContinuationExpired           ContinuationConsumeReason = "expired"
	ContinuationInvalidCapability ContinuationConsumeReason = "invalid-capability"
	ContinuationInvalidTimestamp  ContinuationConsumeReason = "invalid-timestamp"
)

type ContinuationConsumePlan struct {
	Kind   ContinuationConsumeKind
	Reason ContinuationConsumeReason
	Next   Continuation
}

func PlanContinuationConsume(current Continuation, presentedSequence, consumedAt int64) ContinuationConsumePlan {
	if !validTimestamp(consumedAt) {
		return ContinuationConsumePlan{Kind: ContinuationConsumeRejected, Reason: ContinuationInvalidTimestamp}
	}
	if !ValidContinuation(current) || presentedSequence < 0 || presentedSequence > MaximumRevision {
		return ContinuationConsumePlan{Kind: ContinuationConsumeRejected, Reason: ContinuationInvalidCapability}
	}
	if consumedAt >= current.ExpiresAt {
		return ContinuationConsumePlan{Kind: ContinuationConsumeRejected, Reason: ContinuationExpired}
	}
	if current.Sequence > 0 && presentedSequence == current.Sequence-1 {
		return ContinuationConsumePlan{Kind: ContinuationConsumeReplay}
	}
	if presentedSequence != current.Sequence || current.Sequence >= MaximumRevision {
		return ContinuationConsumePlan{Kind: ContinuationConsumeRejected, Reason: ContinuationInvalidCapability}
	}
	next := current
	next.Sequence++
	next.UpdatedAt = consumedAt
	if !ValidContinuation(next) {
		return ContinuationConsumePlan{Kind: ContinuationConsumeRejected, Reason: ContinuationInvalidCapability}
	}
	return ContinuationConsumePlan{Kind: ContinuationConsumeAdvance, Next: next}
}

type ContinuationRecoveryPromotionKind string
type ContinuationRecoveryPromotionReason string

const (
	ContinuationRecoveryPromotionAccepted ContinuationRecoveryPromotionKind = "accepted"
	ContinuationRecoveryPromotionRejected ContinuationRecoveryPromotionKind = "rejected"

	ContinuationRecoveryInvalidClaim        ContinuationRecoveryPromotionReason = "invalid-claim"
	ContinuationRecoveryInvalidContinuation ContinuationRecoveryPromotionReason = "invalid-continuation"
)

type ContinuationRecoveryPromotionPlan struct {
	Kind   ContinuationRecoveryPromotionKind
	Reason ContinuationRecoveryPromotionReason
	Next   Continuation
}

// PlanContinuationRecoveryPromotion promotes the already-authorized
// continuation into a recovery credential at the durable admission boundary:
// the claim of the session-revocation step. The credential remains scoped to
// one operation and can only advance/report that saga; it cannot authorize a
// new deletion or read account data.
func PlanContinuationRecoveryPromotion(
	current Continuation,
	claim Transition,
) ContinuationRecoveryPromotionPlan {
	ready, readyOK := claim.Current.State.(Ready)
	running, runningOK := claim.Next.State.(Running)
	if !readyOK || !runningOK || ready.Step != StepRevokeSessions ||
		running.Step != StepRevokeSessions ||
		!ValidTransition(claim.Current.Scope, claim) {
		return ContinuationRecoveryPromotionPlan{
			Kind: ContinuationRecoveryPromotionRejected, Reason: ContinuationRecoveryInvalidClaim,
		}
	}
	if !ValidContinuation(current) || current.OperationID != claim.Current.OperationID {
		return ContinuationRecoveryPromotionPlan{
			Kind: ContinuationRecoveryPromotionRejected, Reason: ContinuationRecoveryInvalidContinuation,
		}
	}
	next := current
	next.ExpiresAt = identity.MaximumSafeInteger
	if claim.Next.UpdatedAt > next.UpdatedAt {
		next.UpdatedAt = claim.Next.UpdatedAt
	}
	if !ValidContinuation(next) {
		return ContinuationRecoveryPromotionPlan{
			Kind: ContinuationRecoveryPromotionRejected, Reason: ContinuationRecoveryInvalidContinuation,
		}
	}
	return ContinuationRecoveryPromotionPlan{Kind: ContinuationRecoveryPromotionAccepted, Next: next}
}

func RequiresContinuationRecoveryPromotion(transition Transition) bool {
	ready, readyOK := transition.Current.State.(Ready)
	running, runningOK := transition.Next.State.(Running)
	return readyOK && runningOK && ready.Step == StepRevokeSessions &&
		running.Step == StepRevokeSessions
}

func ValidContinuation(continuation Continuation) bool {
	if _, err := ParseOperationID(string(continuation.OperationID)); err != nil {
		return false
	}
	if _, err := ParseCredentialHash(string(continuation.IdempotencyHash)); err != nil {
		return false
	}
	if _, err := ParseCredentialHash(string(continuation.SecretHash)); err != nil {
		return false
	}
	return continuation.Sequence >= 0 && continuation.Sequence <= MaximumRevision &&
		validTimestamp(continuation.CreatedAt) && validTimestamp(continuation.UpdatedAt) &&
		validTimestamp(continuation.ExpiresAt) && continuation.ExpiresAt > continuation.CreatedAt &&
		continuation.UpdatedAt >= continuation.CreatedAt && continuation.UpdatedAt < continuation.ExpiresAt
}

type RunPlanKind string
type RunPlanReason string

const (
	RunReport       RunPlanKind = "report"
	RunClaimStep    RunPlanKind = "claim-step"
	RunAdvanceState RunPlanKind = "advance-state"
	RunRejected     RunPlanKind = "rejected"

	RunInvalidPolicy    RunPlanReason = "invalid-policy"
	RunInvalidState     RunPlanReason = "invalid-state"
	RunInvalidTimestamp RunPlanReason = "invalid-timestamp"
)

type RunPlan struct {
	Kind       RunPlanKind
	Reason     RunPlanReason
	Transition Transition
}

func PlanRun(snapshot Snapshot, now, leaseDurationMilli int64, policy RetryPolicy) RunPlan {
	if !validTimestamp(now) {
		return RunPlan{Kind: RunRejected, Reason: RunInvalidTimestamp}
	}
	if !ValidSnapshot(snapshot) {
		return RunPlan{Kind: RunRejected, Reason: RunInvalidState}
	}
	operation := snapshot.Operation
	switch state := operation.State.(type) {
	case Completed, TerminalFailure:
		return RunPlan{Kind: RunReport}
	case Ready:
		if now < state.NotBefore {
			return RunPlan{Kind: RunReport}
		}
		if leaseDurationMilli <= 0 || leaseDurationMilli > identity.MaximumSafeInteger-now {
			return RunPlan{Kind: RunRejected, Reason: RunInvalidPolicy}
		}
		plan := PlanStepClaim(operation, now, now+leaseDurationMilli)
		if plan.Kind != PlanAccepted {
			return RunPlan{Kind: RunRejected, Reason: RunInvalidState}
		}
		return RunPlan{Kind: RunClaimStep, Transition: plan.Transition}
	case RetryWait:
		if now < state.RetryAt {
			return RunPlan{Kind: RunReport}
		}
		plan := PlanRetryResume(operation, now)
		if plan.Kind != PlanAccepted {
			return RunPlan{Kind: RunRejected, Reason: RunInvalidState}
		}
		return RunPlan{Kind: RunAdvanceState, Transition: plan.Transition}
	case Running:
		if now < state.LeaseExpiresAt {
			return RunPlan{Kind: RunReport}
		}
		plan := PlanExpiredLeaseRecovery(operation, now, policy)
		if plan.Kind != PlanAccepted {
			return RunPlan{Kind: RunRejected, Reason: RunInvalidState}
		}
		return RunPlan{Kind: RunAdvanceState, Transition: plan.Transition}
	default:
		return RunPlan{Kind: RunRejected, Reason: RunInvalidState}
	}
}

type PublicStatusKind string

const (
	PublicInProgress PublicStatusKind = "in-progress"
	PublicRetryWait  PublicStatusKind = "retry-wait"
	PublicFailed     PublicStatusKind = "failed"
	PublicCompleted  PublicStatusKind = "completed"
)

type PublicStatus struct {
	Kind    PublicStatusKind
	RetryAt *int64
}

func PublicStatusFromSnapshot(snapshot Snapshot) (PublicStatus, bool) {
	if !ValidSnapshot(snapshot) {
		return PublicStatus{}, false
	}
	switch state := snapshot.Operation.State.(type) {
	case Ready, Running:
		return PublicStatus{Kind: PublicInProgress}, true
	case RetryWait:
		retryAt := state.RetryAt
		return PublicStatus{Kind: PublicRetryWait, RetryAt: &retryAt}, true
	case TerminalFailure:
		return PublicStatus{Kind: PublicFailed}, true
	case Completed:
		return PublicStatus{Kind: PublicCompleted}, true
	default:
		return PublicStatus{}, false
	}
}
