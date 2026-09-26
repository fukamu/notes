package telemetry

type AlertPlan interface {
	isAlertPlan()
}

type NoAlert struct{}

func (NoAlert) isAlertPlan() {}

type AlertSignal string

const (
	AlertIntegrityFailure       AlertSignal = "integrity-failure"
	AlertServiceFailure         AlertSignal = "service-failure"
	AlertBillingLock            AlertSignal = "billing-lock"
	AlertBillingProviderFailure AlertSignal = "billing-provider-failure"
)

type AlertRoute string

const (
	AlertRouteSecurityOperations AlertRoute = "security-operations"
	AlertRouteServiceOperations  AlertRoute = "service-operations"
	AlertRouteBillingOperations  AlertRoute = "billing-operations"
)

type AlertThresholdKind string

const AlertThresholdDecisionRequired AlertThresholdKind = "decision-required"

type AlertThreshold struct {
	kind AlertThresholdKind
}

func (threshold AlertThreshold) Kind() AlertThresholdKind { return threshold.kind }

type AlertCandidate struct {
	signal    AlertSignal
	route     AlertRoute
	threshold AlertThreshold
}

func (AlertCandidate) isAlertPlan()                        {}
func (candidate AlertCandidate) Signal() AlertSignal       { return candidate.signal }
func (candidate AlertCandidate) Route() AlertRoute         { return candidate.route }
func (candidate AlertCandidate) Threshold() AlertThreshold { return candidate.threshold }

func PlanAlert(event Event) (AlertPlan, error) {
	if !validEvent(event) {
		return nil, ErrInvalidEvent
	}
	switch {
	case event.failureCategory == FailureIntegrity:
		return AlertCandidate{
			signal: AlertIntegrityFailure, route: AlertRouteSecurityOperations,
			threshold: AlertThreshold{kind: AlertThresholdDecisionRequired},
		}, nil
	case event.failureCategory == FailureBilling:
		return AlertCandidate{
			signal: AlertBillingLock, route: AlertRouteBillingOperations,
			threshold: AlertThreshold{kind: AlertThresholdDecisionRequired},
		}, nil
	case event.operation == OperationStripeBilling && event.outcome == OutcomeFailure:
		return AlertCandidate{
			signal: AlertBillingProviderFailure, route: AlertRouteBillingOperations,
			threshold: AlertThreshold{kind: AlertThresholdDecisionRequired},
		}, nil
	case event.outcome == OutcomeFailure &&
		(event.failureCategory == FailureDependency || event.failureCategory == FailureInternal):
		return AlertCandidate{
			signal: AlertServiceFailure, route: AlertRouteServiceOperations,
			threshold: AlertThreshold{kind: AlertThresholdDecisionRequired},
		}, nil
	default:
		return NoAlert{}, nil
	}
}
