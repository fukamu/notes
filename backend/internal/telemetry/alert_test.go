package telemetry_test

import (
	"testing"

	"github.com/fukamu/notes/backend/internal/telemetry"
)

func TestPlanAlertPreservesProviderNeutralRoutingAndPrecedence(t *testing.T) {
	t.Parallel()
	tests := []struct {
		name       string
		operation  telemetry.Operation
		outcome    telemetry.Outcome
		failure    telemetry.FailureCategory
		wantAlert  bool
		wantSignal telemetry.AlertSignal
		wantRoute  telemetry.AlertRoute
	}{
		{
			name: "authentication denial does not alert", operation: telemetry.OperationGoogleOIDC,
			outcome: telemetry.OutcomeDenied, failure: telemetry.FailureAuthentication,
		},
		{
			name: "billing lock", operation: telemetry.OperationSyncV2,
			outcome: telemetry.OutcomeLocked, failure: telemetry.FailureBilling,
			wantAlert: true, wantSignal: telemetry.AlertBillingLock, wantRoute: telemetry.AlertRouteBillingOperations,
		},
		{
			name: "integrity has security precedence", operation: telemetry.OperationStripeBilling,
			outcome: telemetry.OutcomeFailure, failure: telemetry.FailureIntegrity,
			wantAlert: true, wantSignal: telemetry.AlertIntegrityFailure, wantRoute: telemetry.AlertRouteSecurityOperations,
		},
		{
			name: "billing failure category precedes provider signal", operation: telemetry.OperationStripeBilling,
			outcome: telemetry.OutcomeFailure, failure: telemetry.FailureBilling,
			wantAlert: true, wantSignal: telemetry.AlertBillingLock, wantRoute: telemetry.AlertRouteBillingOperations,
		},
		{
			name: "stripe dependency failure", operation: telemetry.OperationStripeBilling,
			outcome: telemetry.OutcomeFailure, failure: telemetry.FailureDependency,
			wantAlert: true, wantSignal: telemetry.AlertBillingProviderFailure, wantRoute: telemetry.AlertRouteBillingOperations,
		},
		{
			name: "stripe internal failure", operation: telemetry.OperationStripeBilling,
			outcome: telemetry.OutcomeFailure, failure: telemetry.FailureInternal,
			wantAlert: true, wantSignal: telemetry.AlertBillingProviderFailure, wantRoute: telemetry.AlertRouteBillingOperations,
		},
		{
			name: "service dependency failure", operation: telemetry.OperationSyncV2,
			outcome: telemetry.OutcomeFailure, failure: telemetry.FailureDependency,
			wantAlert: true, wantSignal: telemetry.AlertServiceFailure, wantRoute: telemetry.AlertRouteServiceOperations,
		},
		{
			name: "service internal failure", operation: telemetry.OperationEnvelopeCrypto,
			outcome: telemetry.OutcomeFailure, failure: telemetry.FailureInternal,
			wantAlert: true, wantSignal: telemetry.AlertServiceFailure, wantRoute: telemetry.AlertRouteServiceOperations,
		},
		{
			name: "expected conflict does not alert", operation: telemetry.OperationSyncV2,
			outcome: telemetry.OutcomeDenied, failure: telemetry.FailureConflict,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			event := acceptedEvent(t, test.operation, test.outcome, test.failure)
			got, err := telemetry.PlanAlert(event)
			if err != nil {
				t.Fatal(err)
			}
			candidate, isCandidate := got.(telemetry.AlertCandidate)
			if isCandidate != test.wantAlert {
				t.Fatalf("alert type = %T, want candidate=%t", got, test.wantAlert)
			}
			if !test.wantAlert {
				if _, ok := got.(telemetry.NoAlert); !ok {
					t.Fatalf("no-alert type = %T", got)
				}
				return
			}
			if candidate.Signal() != test.wantSignal || candidate.Route() != test.wantRoute ||
				candidate.Threshold().Kind() != telemetry.AlertThresholdDecisionRequired {
				t.Fatalf("candidate = (%q, %q, %q)", candidate.Signal(), candidate.Route(), candidate.Threshold().Kind())
			}
		})
	}
}
