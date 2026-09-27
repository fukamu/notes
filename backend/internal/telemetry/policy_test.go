package telemetry_test

import (
	"math"
	"testing"

	"github.com/fukamu/notes/backend/internal/telemetry"
)

func TestPlanEventExhaustivelyEnforcesVocabularyAndCoherence(t *testing.T) {
	t.Parallel()
	operations := []telemetry.Operation{
		telemetry.OperationGoogleOIDC, telemetry.OperationEmailOTP, telemetry.OperationSyncV2,
		telemetry.OperationStripeBilling, telemetry.OperationEncryptedObject, telemetry.OperationEnvelopeCrypto,
	}
	outcomes := []telemetry.Outcome{
		telemetry.OutcomeSuccess, telemetry.OutcomeNoChange, telemetry.OutcomeReplayed,
		telemetry.OutcomeDenied, telemetry.OutcomeLocked, telemetry.OutcomeFailure,
	}
	failures := []telemetry.FailureCategory{
		telemetry.FailureNone, telemetry.FailureAuthentication, telemetry.FailureAuthorization,
		telemetry.FailureInvalidInput, telemetry.FailureBilling, telemetry.FailureQuota,
		telemetry.FailureConflict, telemetry.FailureDependency, telemetry.FailureIntegrity,
		telemetry.FailureInternal,
	}
	acceptedCount := 0
	for _, operation := range operations {
		for _, outcome := range outcomes {
			for _, failure := range failures {
				plan := telemetry.PlanEvent(telemetry.EventInput{
					Operation: operation, Outcome: outcome, FailureCategory: failure,
					DurationBucket: telemetry.DurationNotMeasured, WorkItemsBucket: telemetry.CountZero,
				})
				succeeded := outcome == telemetry.OutcomeSuccess || outcome == telemetry.OutcomeNoChange ||
					outcome == telemetry.OutcomeReplayed
				coherent := succeeded == (failure == telemetry.FailureNone)
				switch result := plan.(type) {
				case telemetry.AcceptedEvent:
					if !coherent {
						t.Fatalf("accepted incoherent operation=%q outcome=%q failure=%q", operation, outcome, failure)
					}
					acceptedCount++
					event := result.Event()
					if event.SchemaVersion() != telemetry.SchemaVersion || event.Operation() != operation ||
						event.Outcome() != outcome || event.FailureCategory() != failure ||
						event.DurationBucket() != telemetry.DurationNotMeasured ||
						event.WorkItemsBucket() != telemetry.CountZero {
						t.Fatalf("event lost bounded values: %#v", event)
					}
				case telemetry.RejectedEvent:
					if coherent || result.Reason() != telemetry.RejectionIncoherentFailureCategory {
						t.Fatalf("unexpected rejection operation=%q outcome=%q failure=%q reason=%q", operation, outcome, failure, result.Reason())
					}
				default:
					t.Fatalf("unknown event-plan type %T", plan)
				}
			}
		}
	}
	if acceptedCount != len(operations)*30 {
		t.Fatalf("accepted combinations = %d, want %d", acceptedCount, len(operations)*30)
	}

	valid := telemetry.EventInput{
		Operation: telemetry.OperationSyncV2, Outcome: telemetry.OutcomeSuccess,
		FailureCategory: telemetry.FailureNone, DurationBucket: telemetry.DurationNotMeasured,
		WorkItemsBucket: telemetry.CountZero,
	}
	invalid := []telemetry.EventInput{
		withOperation(valid, telemetry.Operation("tenant-operation")),
		withOutcome(valid, telemetry.Outcome("partial-success")),
		withFailure(valid, telemetry.FailureCategory("raw-provider-error")),
		withDuration(valid, telemetry.DurationBucket("123ms")),
		withCount(valid, telemetry.CountBucket("account-123")),
	}
	for _, input := range invalid {
		result, ok := telemetry.PlanEvent(input).(telemetry.RejectedEvent)
		if !ok || result.Reason() != telemetry.RejectionInvalidVocabulary {
			t.Fatalf("invalid vocabulary accepted or misclassified: %#v", input)
		}
	}
}

func TestBucketDurationUsesStableBoundariesAndRejectsInvalidNumbers(t *testing.T) {
	t.Parallel()
	tests := []struct {
		value  *float64
		bucket telemetry.DurationBucket
		ok     bool
	}{
		{value: nil, bucket: telemetry.DurationNotMeasured, ok: true},
		{value: floatPointer(0), bucket: telemetry.DurationUnder10MS, ok: true},
		{value: floatPointer(9.999), bucket: telemetry.DurationUnder10MS, ok: true},
		{value: floatPointer(10), bucket: telemetry.Duration10To99MS, ok: true},
		{value: floatPointer(99.999), bucket: telemetry.Duration10To99MS, ok: true},
		{value: floatPointer(100), bucket: telemetry.Duration100To999MS, ok: true},
		{value: floatPointer(999.999), bucket: telemetry.Duration100To999MS, ok: true},
		{value: floatPointer(1_000), bucket: telemetry.Duration1SOrMore, ok: true},
		{value: floatPointer(math.MaxFloat64), bucket: telemetry.Duration1SOrMore, ok: true},
		{value: floatPointer(-1), ok: false},
		{value: floatPointer(math.NaN()), ok: false},
		{value: floatPointer(math.Inf(1)), ok: false},
		{value: floatPointer(math.Inf(-1)), ok: false},
	}
	for _, test := range tests {
		bucket, ok := telemetry.BucketDuration(test.value)
		if ok != test.ok || bucket != test.bucket {
			t.Fatalf("BucketDuration(%v) = (%q, %t), want (%q, %t)", pointerValue(test.value), bucket, ok, test.bucket, test.ok)
		}
	}
}

func TestBucketCountUsesStableBoundariesAndRejectsUnsafeCounts(t *testing.T) {
	t.Parallel()
	tests := []struct {
		value  *float64
		bucket telemetry.CountBucket
		ok     bool
	}{
		{value: nil, bucket: telemetry.CountNotMeasured, ok: true},
		{value: floatPointer(0), bucket: telemetry.CountZero, ok: true},
		{value: floatPointer(1), bucket: telemetry.CountOne, ok: true},
		{value: floatPointer(2), bucket: telemetry.Count2To10, ok: true},
		{value: floatPointer(10), bucket: telemetry.Count2To10, ok: true},
		{value: floatPointer(11), bucket: telemetry.Count11To100, ok: true},
		{value: floatPointer(100), bucket: telemetry.Count11To100, ok: true},
		{value: floatPointer(101), bucket: telemetry.Count101To1000, ok: true},
		{value: floatPointer(1_000), bucket: telemetry.Count101To1000, ok: true},
		{value: floatPointer(1_001), bucket: telemetry.CountOver1000, ok: true},
		{value: floatPointer(telemetry.MaximumSafeIntegerCount), bucket: telemetry.CountOver1000, ok: true},
		{value: floatPointer(-1), ok: false},
		{value: floatPointer(1.5), ok: false},
		{value: floatPointer(telemetry.MaximumSafeIntegerCount + 1), ok: false},
		{value: floatPointer(math.NaN()), ok: false},
		{value: floatPointer(math.Inf(1)), ok: false},
	}
	for _, test := range tests {
		bucket, ok := telemetry.BucketCount(test.value)
		if ok != test.ok || bucket != test.bucket {
			t.Fatalf("BucketCount(%v) = (%q, %t), want (%q, %t)", pointerValue(test.value), bucket, ok, test.bucket, test.ok)
		}
	}
}

func acceptedEvent(t *testing.T, operation telemetry.Operation, outcome telemetry.Outcome, failure telemetry.FailureCategory) telemetry.Event {
	t.Helper()
	plan := telemetry.PlanEvent(telemetry.EventInput{
		Operation: operation, Outcome: outcome, FailureCategory: failure,
		DurationBucket: telemetry.DurationNotMeasured, WorkItemsBucket: telemetry.CountZero,
	})
	accepted, ok := plan.(telemetry.AcceptedEvent)
	if !ok {
		t.Fatalf("fixture event rejected: %#v", plan)
	}
	return accepted.Event()
}

func withOperation(input telemetry.EventInput, value telemetry.Operation) telemetry.EventInput {
	input.Operation = value
	return input
}

func withOutcome(input telemetry.EventInput, value telemetry.Outcome) telemetry.EventInput {
	input.Outcome = value
	return input
}

func withFailure(input telemetry.EventInput, value telemetry.FailureCategory) telemetry.EventInput {
	input.FailureCategory = value
	return input
}

func withDuration(input telemetry.EventInput, value telemetry.DurationBucket) telemetry.EventInput {
	input.DurationBucket = value
	return input
}

func withCount(input telemetry.EventInput, value telemetry.CountBucket) telemetry.EventInput {
	input.WorkItemsBucket = value
	return input
}

func floatPointer(value float64) *float64 { return &value }

func pointerValue(value *float64) any {
	if value == nil {
		return nil
	}
	return *value
}
