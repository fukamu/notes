package telemetry_test

import (
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/fukamu/notes/backend/internal/telemetry"
)

func TestMetricsForEventReturnsOnlyFixedNamesAndBoundedLabels(t *testing.T) {
	t.Parallel()
	event := acceptedEvent(t, telemetry.OperationEmailOTP, telemetry.OutcomeDenied, telemetry.FailureAuthentication)
	samples, err := telemetry.MetricsForEvent(event)
	if err != nil {
		t.Fatal(err)
	}
	wantNames := [3]telemetry.MetricName{
		telemetry.MetricBoundaryOutcomeTotal,
		telemetry.MetricBoundaryDurationBucketTotal,
		telemetry.MetricBoundaryWorkItemsBucketTotal,
	}
	for index, sample := range samples {
		if sample.Name() != wantNames[index] || sample.Value() != telemetry.MetricSampleValue {
			t.Fatalf("sample[%d] = (%q, %d)", index, sample.Name(), sample.Value())
		}
		if sample.Operation() != telemetry.OperationEmailOTP {
			t.Fatalf("sample[%d] operation = %q", index, sample.Operation())
		}
	}
	if outcome, ok := samples[0].Outcome(); !ok || outcome != telemetry.OutcomeDenied {
		t.Fatalf("outcome label = (%q, %t)", outcome, ok)
	}
	if failure, ok := samples[0].FailureCategory(); !ok || failure != telemetry.FailureAuthentication {
		t.Fatalf("failure label = (%q, %t)", failure, ok)
	}
	if duration, ok := samples[1].DurationBucket(); !ok || duration != telemetry.DurationNotMeasured {
		t.Fatalf("duration label = (%q, %t)", duration, ok)
	}
	if count, ok := samples[2].WorkItemsBucket(); !ok || count != telemetry.CountZero {
		t.Fatalf("work-items label = (%q, %t)", count, ok)
	}
	if _, ok := samples[0].DurationBucket(); ok {
		t.Fatal("outcome metric exposed a duration label")
	}
	if _, ok := samples[1].Outcome(); ok {
		t.Fatal("duration metric exposed an outcome label")
	}
	if _, ok := samples[2].FailureCategory(); ok {
		t.Fatal("work-items metric exposed a failure label")
	}
	serialized, err := json.Marshal(samples)
	if err != nil {
		t.Fatal(err)
	}
	want := `[{"name":"boundary-outcome-total","value":1,"labels":{"operation":"auth-email-otp","outcome":"denied","failureCategory":"authentication"}},{"name":"boundary-duration-bucket-total","value":1,"labels":{"operation":"auth-email-otp","durationBucket":"not-measured"}},{"name":"boundary-work-items-bucket-total","value":1,"labels":{"operation":"auth-email-otp","workItemsBucket":"zero"}}]`
	if string(serialized) != want {
		t.Fatalf("serialized metrics = %s", serialized)
	}
	lower := strings.ToLower(string(serialized))
	for _, forbidden := range []string{
		securityCorpusMarker, "accountid", "vaultid", "cardid", "sessionid", "mutationid",
		"token", "cookie", "secret", "title", "body", "link", "customer", "payment",
	} {
		if strings.Contains(lower, strings.ToLower(forbidden)) {
			t.Fatalf("metric labels contain forbidden dimension %q: %s", forbidden, serialized)
		}
	}
}

func TestMetricsAndAlertsRejectZeroValueEvents(t *testing.T) {
	t.Parallel()
	if _, err := telemetry.MetricsForEvent(telemetry.Event{}); !errors.Is(err, telemetry.ErrInvalidEvent) {
		t.Fatalf("metric error = %v", err)
	}
	if _, err := telemetry.PlanAlert(telemetry.Event{}); !errors.Is(err, telemetry.ErrInvalidEvent) {
		t.Fatalf("alert error = %v", err)
	}
	if _, err := json.Marshal(telemetry.MetricSample{}); err == nil {
		t.Fatal("zero metric sample serialized")
	}
}
