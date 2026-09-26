package telemetry_test

import (
	"testing"

	"github.com/fukamu/notes/backend/internal/telemetry"
)

func TestRecordSafelyPreservesOrderAndIsolatesSinkFailure(t *testing.T) {
	t.Parallel()
	ordered := []telemetry.Event{
		acceptedEvent(t, telemetry.OperationSyncV2, telemetry.OutcomeSuccess, telemetry.FailureNone),
		acceptedEvent(t, telemetry.OperationEmailOTP, telemetry.OutcomeDenied, telemetry.FailureAuthentication),
		acceptedEvent(t, telemetry.OperationEnvelopeCrypto, telemetry.OutcomeFailure, telemetry.FailureDependency),
		acceptedEvent(t, telemetry.OperationSyncV2, telemetry.OutcomeNoChange, telemetry.FailureNone),
	}
	fake := &telemetrySinkStub{result: telemetry.SinkBuffered, failAfter: -1}
	for _, event := range ordered {
		plan := telemetry.PlanEvent(telemetry.EventInput{
			Operation: event.Operation(), Outcome: event.Outcome(), FailureCategory: event.FailureCategory(),
			DurationBucket: event.DurationBucket(), WorkItemsBucket: event.WorkItemsBucket(),
		})
		delivery := telemetry.RecordSafely(fake, plan)
		if delivery.Kind() != telemetry.DeliveryRecorded || delivery.Reason() != "" {
			t.Fatalf("delivery = (%q, %q)", delivery.Kind(), delivery.Reason())
		}
	}
	if len(fake.records) != len(ordered) {
		t.Fatalf("record count = %d", len(fake.records))
	}
	for index := range ordered {
		if fake.records[index] != ordered[index] {
			t.Fatalf("record[%d] changed", index)
		}
	}

	failed := &telemetrySinkStub{result: telemetry.SinkBuffered, failAfter: 0}
	assertDelivery(t, telemetry.RecordSafely(failed, acceptedPlan(t, ordered[0])), telemetry.DeliveryDropped, telemetry.DropSinkFailure)
	if len(failed.records) != 0 {
		t.Fatalf("failed sink retained records: %d", len(failed.records))
	}
	dropped := &telemetrySinkStub{result: telemetry.SinkDropped, failAfter: -1}
	assertDelivery(t, telemetry.RecordSafely(dropped, acceptedPlan(t, ordered[0])), telemetry.DeliveryDropped, telemetry.DropSinkRejected)
	invalidResult := &telemetrySinkStub{result: telemetry.SinkResult("unknown"), failAfter: -1}
	assertDelivery(t, telemetry.RecordSafely(invalidResult, acceptedPlan(t, ordered[0])), telemetry.DeliveryDropped, telemetry.DropSinkFailure)
	assertDelivery(t, telemetry.RecordSafely(nil, acceptedPlan(t, ordered[0])), telemetry.DeliveryDropped, telemetry.DropSinkFailure)
	assertDelivery(t, telemetry.RecordSafely(fake, nil), telemetry.DeliveryDropped, telemetry.DropInvalidEvent)
	rejected := telemetry.PlanEvent(telemetry.EventInput{
		Operation: telemetry.OperationSyncV2, Outcome: telemetry.OutcomeSuccess,
		FailureCategory: telemetry.FailureDependency, DurationBucket: telemetry.DurationNotMeasured,
		WorkItemsBucket: telemetry.CountZero,
	})
	assertDelivery(t, telemetry.RecordSafely(fake, rejected), telemetry.DeliveryDropped, telemetry.DropInvalidEvent)
	assertDelivery(t, telemetry.RecordSafely(telemetry.NoOpSink(), acceptedPlan(t, ordered[0])), telemetry.DeliveryRecorded, "")
}

type telemetrySinkStub struct {
	result    telemetry.SinkResult
	failAfter int
	records   []telemetry.Event
}

func (stub *telemetrySinkStub) Record(event telemetry.Event) telemetry.SinkResult {
	if stub.failAfter >= 0 && len(stub.records) >= stub.failAfter {
		panic("synthetic telemetry sink failure")
	}
	stub.records = append(stub.records, event)
	return stub.result
}

func acceptedPlan(t *testing.T, event telemetry.Event) telemetry.EventPlan {
	t.Helper()
	plan := telemetry.PlanEvent(telemetry.EventInput{
		Operation: event.Operation(), Outcome: event.Outcome(), FailureCategory: event.FailureCategory(),
		DurationBucket: event.DurationBucket(), WorkItemsBucket: event.WorkItemsBucket(),
	})
	if _, ok := plan.(telemetry.AcceptedEvent); !ok {
		t.Fatalf("accepted fixture became %T", plan)
	}
	return plan
}

func assertDelivery(t *testing.T, delivery telemetry.Delivery, kind telemetry.DeliveryKind, reason telemetry.DropReason) {
	t.Helper()
	if delivery.Kind() != kind || delivery.Reason() != reason {
		t.Fatalf("delivery = (%q, %q), want (%q, %q)", delivery.Kind(), delivery.Reason(), kind, reason)
	}
}
