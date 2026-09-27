package telemetry

import (
	"encoding/json"
	"errors"
)

type MetricName string

const (
	MetricBoundaryOutcomeTotal         MetricName = "boundary-outcome-total"
	MetricBoundaryDurationBucketTotal  MetricName = "boundary-duration-bucket-total"
	MetricBoundaryWorkItemsBucketTotal MetricName = "boundary-work-items-bucket-total"
	MetricSampleValue                             = 1
)

var errInvalidMetric = errors.New("invalid telemetry metric")

// MetricSample is opaque so callers cannot add a free-form or unvalidated
// dimension. Accessors expose only the fixed labels appropriate to its name.
type MetricSample struct {
	name            MetricName
	operation       Operation
	outcome         Outcome
	failureCategory FailureCategory
	durationBucket  DurationBucket
	workItemsBucket CountBucket
}

func (sample MetricSample) Name() MetricName     { return sample.name }
func (MetricSample) Value() int                  { return MetricSampleValue }
func (sample MetricSample) Operation() Operation { return sample.operation }

func (sample MetricSample) Outcome() (Outcome, bool) {
	return sample.outcome, sample.name == MetricBoundaryOutcomeTotal && validMetricSample(sample)
}

func (sample MetricSample) FailureCategory() (FailureCategory, bool) {
	return sample.failureCategory, sample.name == MetricBoundaryOutcomeTotal && validMetricSample(sample)
}

func (sample MetricSample) DurationBucket() (DurationBucket, bool) {
	return sample.durationBucket, sample.name == MetricBoundaryDurationBucketTotal && validMetricSample(sample)
}

func (sample MetricSample) WorkItemsBucket() (CountBucket, bool) {
	return sample.workItemsBucket, sample.name == MetricBoundaryWorkItemsBucketTotal && validMetricSample(sample)
}

func (sample MetricSample) MarshalJSON() ([]byte, error) {
	if !validMetricSample(sample) {
		return nil, errInvalidMetric
	}
	switch sample.name {
	case MetricBoundaryOutcomeTotal:
		type labels struct {
			Operation       Operation       `json:"operation"`
			Outcome         Outcome         `json:"outcome"`
			FailureCategory FailureCategory `json:"failureCategory"`
		}
		return json.Marshal(metricWire[labels]{
			Name: sample.name, Value: MetricSampleValue,
			Labels: labels{
				Operation: sample.operation, Outcome: sample.outcome,
				FailureCategory: sample.failureCategory,
			},
		})
	case MetricBoundaryDurationBucketTotal:
		type labels struct {
			Operation      Operation      `json:"operation"`
			DurationBucket DurationBucket `json:"durationBucket"`
		}
		return json.Marshal(metricWire[labels]{
			Name: sample.name, Value: MetricSampleValue,
			Labels: labels{Operation: sample.operation, DurationBucket: sample.durationBucket},
		})
	case MetricBoundaryWorkItemsBucketTotal:
		type labels struct {
			Operation       Operation   `json:"operation"`
			WorkItemsBucket CountBucket `json:"workItemsBucket"`
		}
		return json.Marshal(metricWire[labels]{
			Name: sample.name, Value: MetricSampleValue,
			Labels: labels{Operation: sample.operation, WorkItemsBucket: sample.workItemsBucket},
		})
	default:
		return nil, errInvalidMetric
	}
}

type metricWire[TLabels any] struct {
	Name   MetricName `json:"name"`
	Value  int        `json:"value"`
	Labels TLabels    `json:"labels"`
}

func MetricsForEvent(event Event) ([3]MetricSample, error) {
	if !validEvent(event) {
		return [3]MetricSample{}, ErrInvalidEvent
	}
	return [3]MetricSample{
		{
			name: MetricBoundaryOutcomeTotal, operation: event.operation,
			outcome: event.outcome, failureCategory: event.failureCategory,
		},
		{
			name: MetricBoundaryDurationBucketTotal, operation: event.operation,
			durationBucket: event.durationBucket,
		},
		{
			name: MetricBoundaryWorkItemsBucketTotal, operation: event.operation,
			workItemsBucket: event.workItemsBucket,
		},
	}, nil
}

func validMetricSample(sample MetricSample) bool {
	if !validOperation(sample.operation) {
		return false
	}
	switch sample.name {
	case MetricBoundaryOutcomeTotal:
		return validOutcome(sample.outcome) && validFailureCategory(sample.failureCategory) &&
			sample.durationBucket == "" && sample.workItemsBucket == ""
	case MetricBoundaryDurationBucketTotal:
		return validDurationBucket(sample.durationBucket) && sample.outcome == "" &&
			sample.failureCategory == "" && sample.workItemsBucket == ""
	case MetricBoundaryWorkItemsBucketTotal:
		return validCountBucket(sample.workItemsBucket) && sample.outcome == "" &&
			sample.failureCategory == "" && sample.durationBucket == ""
	default:
		return false
	}
}
