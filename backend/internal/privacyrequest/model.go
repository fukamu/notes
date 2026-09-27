package privacyrequest

import "github.com/fukamu/notes/backend/internal/identity"

const MaximumRevision int64 = 2_147_483_647

type RequestKind string

const (
	KindPurposeNotification           RequestKind = "purpose-notification"
	KindDisclosure                    RequestKind = "disclosure"
	KindCorrection                    RequestKind = "correction"
	KindUsageSuspension               RequestKind = "usage-suspension"
	KindDeletion                      RequestKind = "deletion"
	KindThirdPartyProvisionSuspension RequestKind = "third-party-provision-suspension"
)

type Outcome string

const (
	OutcomeFulfilled              Outcome = "fulfilled"
	OutcomeAccountDeletionStarted Outcome = "account-deletion-started"
)

type RejectionReason string

const (
	RejectionIdentityNotVerified  RejectionReason = "identity-not-verified"
	RejectionRequestNotApplicable RejectionReason = "request-not-applicable"
)

type StateKind string

const (
	StateVerificationPending StateKind = "verification-pending"
	StateReady               StateKind = "ready"
	StateProcessing          StateKind = "processing"
	StateCompleted           StateKind = "completed"
	StateRejected            StateKind = "rejected"
	StateFailed              StateKind = "failed"
)

type Scope struct {
	AccountID identity.AccountID
	VaultID   identity.VaultID
}

type State interface {
	privacyRequestState()
	Kind() StateKind
}

type VerificationPending struct{}

func (VerificationPending) privacyRequestState() {}
func (VerificationPending) Kind() StateKind      { return StateVerificationPending }

type Ready struct {
	VerificationReceiptID VerificationReceiptID
	VerifiedAt            int64
}

func (Ready) privacyRequestState() {}
func (Ready) Kind() StateKind      { return StateReady }

type Processing struct {
	VerificationReceiptID VerificationReceiptID
	VerifiedAt            int64
	StartedAt             int64
}

func (Processing) privacyRequestState() {}
func (Processing) Kind() StateKind      { return StateProcessing }

type Completed struct {
	VerificationReceiptID VerificationReceiptID
	VerifiedAt            int64
	StartedAt             int64
	CompletedAt           int64
	Outcome               Outcome
}

func (Completed) privacyRequestState() {}
func (Completed) Kind() StateKind      { return StateCompleted }

type Rejected struct {
	RejectedAt int64
	Reason     RejectionReason
}

func (Rejected) privacyRequestState() {}
func (Rejected) Kind() StateKind      { return StateRejected }

type Failed struct {
	VerificationReceiptID VerificationReceiptID
	VerifiedAt            int64
	StartedAt             int64
	FailedAt              int64
	FailureCode           FailureCode
	Retryable             bool
}

func (Failed) privacyRequestState() {}
func (Failed) Kind() StateKind      { return StateFailed }

type Record struct {
	Scope        Scope
	RequestID    RequestID
	SubmissionID SubmissionID
	RequestKind  RequestKind
	Revision     int64
	State        State
	RequestedAt  int64
	UpdatedAt    int64
}

type Transition struct {
	Current Record
	Next    Record
}

type PlanKind string
type PlanReason string

const (
	PlanAccepted PlanKind = "accepted"
	PlanRejected PlanKind = "rejected"

	ReasonInvalidOutcome   PlanReason = "invalid-outcome"
	ReasonInvalidTimestamp PlanReason = "invalid-timestamp"
	ReasonNotRetryable     PlanReason = "not-retryable"
	ReasonRevisionLimit    PlanReason = "revision-limit"
	ReasonWrongState       PlanReason = "wrong-state"
	ReasonInvalidInput     PlanReason = "invalid-input"
)

type Plan struct {
	Kind       PlanKind
	Reason     PlanReason
	Record     Record
	Transition Transition
}

type VerificationDecisionKind string

const (
	VerificationApproved VerificationDecisionKind = "approved"
	VerificationRejected VerificationDecisionKind = "rejected"
)

type VerificationDecision struct {
	Kind      VerificationDecisionKind
	ReceiptID VerificationReceiptID
	Reason    RejectionReason
	DecidedAt int64
}

func PlanStart(scope Scope, requestID RequestID, submissionID SubmissionID, requestKind RequestKind, requestedAt int64) Plan {
	record := Record{
		Scope: scope, RequestID: requestID, SubmissionID: submissionID,
		RequestKind: requestKind, Revision: 1, State: VerificationPending{},
		RequestedAt: requestedAt, UpdatedAt: requestedAt,
	}
	if !ValidRecord(record) {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidInput}
	}
	return Plan{Kind: PlanAccepted, Record: record}
}

func PlanVerification(record Record, decision VerificationDecision) Plan {
	if _, ok := record.State.(VerificationPending); !ok {
		return Plan{Kind: PlanRejected, Reason: ReasonWrongState}
	}
	if !validEventTimestamp(record, decision.DecidedAt) {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidTimestamp}
	}
	switch decision.Kind {
	case VerificationApproved:
		if _, err := ParseVerificationReceiptID(string(decision.ReceiptID)); err != nil {
			return Plan{Kind: PlanRejected, Reason: ReasonInvalidInput}
		}
		return advance(record, Ready{VerificationReceiptID: decision.ReceiptID, VerifiedAt: decision.DecidedAt}, decision.DecidedAt)
	case VerificationRejected:
		if !validRejectionReason(decision.Reason) {
			return Plan{Kind: PlanRejected, Reason: ReasonInvalidInput}
		}
		return advance(record, Rejected{RejectedAt: decision.DecidedAt, Reason: decision.Reason}, decision.DecidedAt)
	default:
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidInput}
	}
}

func PlanProcessingStart(record Record, startedAt int64) Plan {
	state, ok := record.State.(Ready)
	if !ok {
		return Plan{Kind: PlanRejected, Reason: ReasonWrongState}
	}
	if !validEventTimestamp(record, startedAt) {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidTimestamp}
	}
	return advance(record, Processing{
		VerificationReceiptID: state.VerificationReceiptID,
		VerifiedAt:            state.VerifiedAt,
		StartedAt:             startedAt,
	}, startedAt)
}

func PlanCompletion(record Record, completedAt int64, outcome Outcome) Plan {
	state, ok := record.State.(Processing)
	if !ok {
		return Plan{Kind: PlanRejected, Reason: ReasonWrongState}
	}
	if !validEventTimestamp(record, completedAt) {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidTimestamp}
	}
	if !outcomeMatchesKind(record.RequestKind, outcome) {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidOutcome}
	}
	return advance(record, Completed{
		VerificationReceiptID: state.VerificationReceiptID,
		VerifiedAt:            state.VerifiedAt,
		StartedAt:             state.StartedAt,
		CompletedAt:           completedAt,
		Outcome:               outcome,
	}, completedAt)
}

func PlanFailure(record Record, failedAt int64, failureCode FailureCode, retryable bool) Plan {
	state, ok := record.State.(Processing)
	if !ok {
		return Plan{Kind: PlanRejected, Reason: ReasonWrongState}
	}
	if !validEventTimestamp(record, failedAt) {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidTimestamp}
	}
	if _, err := ParseFailureCode(string(failureCode)); err != nil {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidInput}
	}
	return advance(record, Failed{
		VerificationReceiptID: state.VerificationReceiptID,
		VerifiedAt:            state.VerifiedAt,
		StartedAt:             state.StartedAt,
		FailedAt:              failedAt,
		FailureCode:           failureCode,
		Retryable:             retryable,
	}, failedAt)
}

func PlanRetry(record Record, retriedAt int64) Plan {
	state, ok := record.State.(Failed)
	if !ok {
		return Plan{Kind: PlanRejected, Reason: ReasonWrongState}
	}
	if !state.Retryable {
		return Plan{Kind: PlanRejected, Reason: ReasonNotRetryable}
	}
	if !validEventTimestamp(record, retriedAt) {
		return Plan{Kind: PlanRejected, Reason: ReasonInvalidTimestamp}
	}
	return advance(record, Ready{
		VerificationReceiptID: state.VerificationReceiptID,
		VerifiedAt:            state.VerifiedAt,
	}, retriedAt)
}

func advance(current Record, state State, updatedAt int64) Plan {
	if current.Revision >= MaximumRevision {
		return Plan{Kind: PlanRejected, Reason: ReasonRevisionLimit}
	}
	next := current
	next.Revision++
	next.State = state
	next.UpdatedAt = updatedAt
	transition := Transition{Current: current, Next: next}
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

func ValidRequestKind(kind RequestKind) bool {
	switch kind {
	case KindPurposeNotification, KindDisclosure, KindCorrection, KindUsageSuspension,
		KindDeletion, KindThirdPartyProvisionSuspension:
		return true
	default:
		return false
	}
}

func ValidRecord(record Record) bool {
	if !ValidScope(record.Scope) || !ValidRequestKind(record.RequestKind) ||
		record.Revision < 1 || record.Revision > MaximumRevision ||
		!validTimestamp(record.RequestedAt) || !validTimestamp(record.UpdatedAt) ||
		record.UpdatedAt < record.RequestedAt || record.State == nil {
		return false
	}
	if _, err := ParseRequestID(string(record.RequestID)); err != nil {
		return false
	}
	if _, err := ParseSubmissionID(string(record.SubmissionID)); err != nil {
		return false
	}
	switch state := record.State.(type) {
	case VerificationPending:
		return record.Revision == 1 && record.UpdatedAt == record.RequestedAt
	case Ready:
		return validVerification(state.VerificationReceiptID, state.VerifiedAt, record)
	case Processing:
		return validVerification(state.VerificationReceiptID, state.VerifiedAt, record) &&
			state.StartedAt >= state.VerifiedAt && state.StartedAt == record.UpdatedAt
	case Completed:
		return validVerification(state.VerificationReceiptID, state.VerifiedAt, record) &&
			state.StartedAt >= state.VerifiedAt && state.CompletedAt >= state.StartedAt &&
			state.CompletedAt == record.UpdatedAt && outcomeMatchesKind(record.RequestKind, state.Outcome)
	case Rejected:
		return validRejectionReason(state.Reason) && state.RejectedAt >= record.RequestedAt &&
			state.RejectedAt == record.UpdatedAt
	case Failed:
		_, codeErr := ParseFailureCode(string(state.FailureCode))
		return codeErr == nil && validVerification(state.VerificationReceiptID, state.VerifiedAt, record) &&
			state.StartedAt >= state.VerifiedAt && state.FailedAt >= state.StartedAt &&
			state.FailedAt == record.UpdatedAt
	default:
		return false
	}
}

func InitialRecord(record Record) bool {
	_, pending := record.State.(VerificationPending)
	return ValidRecord(record) && pending && record.Revision == 1 && record.UpdatedAt == record.RequestedAt
}

func ValidTransition(scope Scope, transition Transition) bool {
	return ValidRecord(transition.Current) && ValidRecord(transition.Next) &&
		transition.Current.Scope == scope && transition.Next.Scope == scope &&
		sameIdentity(transition.Current, transition.Next) &&
		transition.Next.Revision == transition.Current.Revision+1 &&
		transition.Next.UpdatedAt >= transition.Current.UpdatedAt &&
		validStateTransition(transition.Current.State, transition.Next.State)
}

func SameRecord(left Record, right Record) bool {
	return sameIdentity(left, right) && left.Revision == right.Revision &&
		left.UpdatedAt == right.UpdatedAt && sameState(left.State, right.State)
}

func sameIdentity(left Record, right Record) bool {
	return left.Scope == right.Scope && left.RequestID == right.RequestID &&
		left.SubmissionID == right.SubmissionID && left.RequestKind == right.RequestKind &&
		left.RequestedAt == right.RequestedAt
}

func validStateTransition(current State, next State) bool {
	switch currentState := current.(type) {
	case VerificationPending:
		switch next.(type) {
		case Ready, Rejected:
			return true
		}
	case Ready:
		nextState, ok := next.(Processing)
		return ok && sameVerification(currentState, nextState)
	case Processing:
		switch nextState := next.(type) {
		case Completed:
			return sameVerification(currentState, nextState) && currentState.StartedAt == nextState.StartedAt
		case Failed:
			return sameVerification(currentState, nextState) && currentState.StartedAt == nextState.StartedAt
		}
	case Failed:
		nextState, ok := next.(Ready)
		return currentState.Retryable && ok && sameVerification(currentState, nextState)
	}
	return false
}

type verifiedState interface {
	verification() (VerificationReceiptID, int64)
}

func (state Ready) verification() (VerificationReceiptID, int64) {
	return state.VerificationReceiptID, state.VerifiedAt
}
func (state Processing) verification() (VerificationReceiptID, int64) {
	return state.VerificationReceiptID, state.VerifiedAt
}
func (state Completed) verification() (VerificationReceiptID, int64) {
	return state.VerificationReceiptID, state.VerifiedAt
}
func (state Failed) verification() (VerificationReceiptID, int64) {
	return state.VerificationReceiptID, state.VerifiedAt
}

func sameVerification(left verifiedState, right verifiedState) bool {
	leftID, leftAt := left.verification()
	rightID, rightAt := right.verification()
	return leftID == rightID && leftAt == rightAt
}

func sameState(left State, right State) bool {
	switch leftState := left.(type) {
	case VerificationPending:
		_, ok := right.(VerificationPending)
		return ok
	case Ready:
		rightState, ok := right.(Ready)
		return ok && leftState == rightState
	case Processing:
		rightState, ok := right.(Processing)
		return ok && leftState == rightState
	case Completed:
		rightState, ok := right.(Completed)
		return ok && leftState == rightState
	case Rejected:
		rightState, ok := right.(Rejected)
		return ok && leftState == rightState
	case Failed:
		rightState, ok := right.(Failed)
		return ok && leftState == rightState
	default:
		return false
	}
}

func validVerification(receiptID VerificationReceiptID, verifiedAt int64, record Record) bool {
	_, receiptErr := ParseVerificationReceiptID(string(receiptID))
	return receiptErr == nil && validTimestamp(verifiedAt) &&
		verifiedAt >= record.RequestedAt && verifiedAt <= record.UpdatedAt
}

func validRejectionReason(reason RejectionReason) bool {
	return reason == RejectionIdentityNotVerified || reason == RejectionRequestNotApplicable
}

func outcomeMatchesKind(kind RequestKind, outcome Outcome) bool {
	if kind == KindDeletion {
		return outcome == OutcomeAccountDeletionStarted
	}
	return outcome == OutcomeFulfilled
}

func validEventTimestamp(record Record, timestamp int64) bool {
	return validTimestamp(timestamp) && timestamp >= record.UpdatedAt
}

func validTimestamp(value int64) bool {
	return value >= 0 && value <= identity.MaximumSafeInteger
}
