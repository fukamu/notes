package telemetry

import "math"

const (
	SchemaVersion           = 1
	MaximumSafeIntegerCount = 9_007_199_254_740_991
)

type Operation string

const (
	OperationGoogleOIDC      Operation = "auth-google-oidc"
	OperationEmailOTP        Operation = "auth-email-otp"
	OperationSyncV2          Operation = "sync-v2"
	OperationStripeBilling   Operation = "billing-stripe"
	OperationEncryptedObject Operation = "storage-encrypted-object"
	OperationEnvelopeCrypto  Operation = "crypto-envelope"
)

type Outcome string

const (
	OutcomeSuccess  Outcome = "success"
	OutcomeNoChange Outcome = "no-change"
	OutcomeReplayed Outcome = "replayed"
	OutcomeDenied   Outcome = "denied"
	OutcomeLocked   Outcome = "locked"
	OutcomeFailure  Outcome = "failure"
)

type FailureCategory string

const (
	FailureNone           FailureCategory = "none"
	FailureAuthentication FailureCategory = "authentication"
	FailureAuthorization  FailureCategory = "authorization"
	FailureInvalidInput   FailureCategory = "invalid-input"
	FailureBilling        FailureCategory = "billing"
	FailureQuota          FailureCategory = "quota"
	FailureConflict       FailureCategory = "conflict"
	FailureDependency     FailureCategory = "dependency"
	FailureIntegrity      FailureCategory = "integrity"
	FailureInternal       FailureCategory = "internal"
)

type DurationBucket string

const (
	DurationNotMeasured DurationBucket = "not-measured"
	DurationUnder10MS   DurationBucket = "under-10ms"
	Duration10To99MS    DurationBucket = "10-99ms"
	Duration100To999MS  DurationBucket = "100-999ms"
	Duration1SOrMore    DurationBucket = "1s-or-more"
)

type CountBucket string

const (
	CountNotMeasured CountBucket = "not-measured"
	CountZero        CountBucket = "zero"
	CountOne         CountBucket = "one"
	Count2To10       CountBucket = "2-10"
	Count11To100     CountBucket = "11-100"
	Count101To1000   CountBucket = "101-1000"
	CountOver1000    CountBucket = "over-1000"
)

type EventInput struct {
	Operation       Operation
	Outcome         Outcome
	FailureCategory FailureCategory
	DurationBucket  DurationBucket
	WorkItemsBucket CountBucket
}

// Event is intentionally opaque. Callers construct one through PlanEvent or
// DecodeEventJSON, so arbitrary content and identifiers cannot become metric
// dimensions by adding fields at a call site.
type Event struct {
	schemaVersion   int
	operation       Operation
	outcome         Outcome
	failureCategory FailureCategory
	durationBucket  DurationBucket
	workItemsBucket CountBucket
}

func (event Event) SchemaVersion() int               { return event.schemaVersion }
func (event Event) Operation() Operation             { return event.operation }
func (event Event) Outcome() Outcome                 { return event.outcome }
func (event Event) FailureCategory() FailureCategory { return event.failureCategory }
func (event Event) DurationBucket() DurationBucket   { return event.durationBucket }
func (event Event) WorkItemsBucket() CountBucket     { return event.workItemsBucket }

type EventPlan interface {
	isEventPlan()
}

type AcceptedEvent struct {
	event Event
}

func (AcceptedEvent) isEventPlan() {}
func (plan AcceptedEvent) Event() Event {
	return plan.event
}

type EventRejectionReason string

const (
	RejectionInvalidVocabulary         EventRejectionReason = "invalid-vocabulary"
	RejectionIncoherentFailureCategory EventRejectionReason = "incoherent-failure-category"
)

type RejectedEvent struct {
	reason EventRejectionReason
}

func (RejectedEvent) isEventPlan() {}
func (plan RejectedEvent) Reason() EventRejectionReason {
	return plan.reason
}

func PlanEvent(input EventInput) EventPlan {
	if !validOperation(input.Operation) || !validOutcome(input.Outcome) ||
		!validFailureCategory(input.FailureCategory) || !validDurationBucket(input.DurationBucket) ||
		!validCountBucket(input.WorkItemsBucket) {
		return RejectedEvent{reason: RejectionInvalidVocabulary}
	}
	succeeded := input.Outcome == OutcomeSuccess || input.Outcome == OutcomeNoChange ||
		input.Outcome == OutcomeReplayed
	if succeeded != (input.FailureCategory == FailureNone) {
		return RejectedEvent{reason: RejectionIncoherentFailureCategory}
	}
	return AcceptedEvent{event: Event{
		schemaVersion: SchemaVersion, operation: input.Operation, outcome: input.Outcome,
		failureCategory: input.FailureCategory, durationBucket: input.DurationBucket,
		workItemsBucket: input.WorkItemsBucket,
	}}
}

// BucketDuration converts an optional finite, non-negative millisecond value
// into a fixed aggregation bucket. A nil value means it was not measured.
func BucketDuration(durationMilliseconds *float64) (DurationBucket, bool) {
	if durationMilliseconds == nil {
		return DurationNotMeasured, true
	}
	value := *durationMilliseconds
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 {
		return "", false
	}
	switch {
	case value < 10:
		return DurationUnder10MS, true
	case value < 100:
		return Duration10To99MS, true
	case value < 1_000:
		return Duration100To999MS, true
	default:
		return Duration1SOrMore, true
	}
}

// BucketCount accepts the same JSON-number domain as the legacy boundary and
// rejects fractions, negative values and values above JavaScript's safe integer
// range before reducing the count to a fixed aggregation bucket.
func BucketCount(count *float64) (CountBucket, bool) {
	if count == nil {
		return CountNotMeasured, true
	}
	value := *count
	if math.IsNaN(value) || math.IsInf(value, 0) || value < 0 ||
		math.Trunc(value) != value || value > MaximumSafeIntegerCount {
		return "", false
	}
	switch {
	case value == 0:
		return CountZero, true
	case value == 1:
		return CountOne, true
	case value <= 10:
		return Count2To10, true
	case value <= 100:
		return Count11To100, true
	case value <= 1_000:
		return Count101To1000, true
	default:
		return CountOver1000, true
	}
}

func validEvent(event Event) bool {
	if event.schemaVersion != SchemaVersion {
		return false
	}
	plan := PlanEvent(EventInput{
		Operation: event.operation, Outcome: event.outcome, FailureCategory: event.failureCategory,
		DurationBucket: event.durationBucket, WorkItemsBucket: event.workItemsBucket,
	})
	_, accepted := plan.(AcceptedEvent)
	return accepted
}

func validOperation(value Operation) bool {
	switch value {
	case OperationGoogleOIDC, OperationEmailOTP, OperationSyncV2, OperationStripeBilling,
		OperationEncryptedObject, OperationEnvelopeCrypto:
		return true
	default:
		return false
	}
}

func validOutcome(value Outcome) bool {
	switch value {
	case OutcomeSuccess, OutcomeNoChange, OutcomeReplayed, OutcomeDenied, OutcomeLocked, OutcomeFailure:
		return true
	default:
		return false
	}
}

func validFailureCategory(value FailureCategory) bool {
	switch value {
	case FailureNone, FailureAuthentication, FailureAuthorization, FailureInvalidInput, FailureBilling,
		FailureQuota, FailureConflict, FailureDependency, FailureIntegrity, FailureInternal:
		return true
	default:
		return false
	}
}

func validDurationBucket(value DurationBucket) bool {
	switch value {
	case DurationNotMeasured, DurationUnder10MS, Duration10To99MS, Duration100To999MS, Duration1SOrMore:
		return true
	default:
		return false
	}
}

func validCountBucket(value CountBucket) bool {
	switch value {
	case CountNotMeasured, CountZero, CountOne, Count2To10, Count11To100, Count101To1000, CountOver1000:
		return true
	default:
		return false
	}
}
