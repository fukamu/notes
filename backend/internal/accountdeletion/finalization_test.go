package accountdeletion

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

func TestPlanAccountFinalizationRejectsScopeCommandAndPolicy(t *testing.T) {
	scope := finalizationScope(t, 1)
	command := finalizationCommand(t, scope)
	accepted := PlanAccountFinalization(scope, command, LegalEvidenceFinalizationPolicy{Kind: LegalEvidencePolicyUndecided})
	if accepted.Kind != AccountFinalizationPlanAccepted || accepted.Command != command {
		t.Fatalf("accepted plan = %#v", accepted)
	}

	invalid := command
	invalid.AttemptedAt = invalid.PreviousReceiptAt - 1
	if got := PlanAccountFinalization(scope, invalid, LegalEvidenceFinalizationPolicy{Kind: LegalEvidencePolicyUndecided}); got.Reason != AccountFinalizationInvalidCommand {
		t.Fatalf("invalid command plan = %#v", got)
	}
	if got := PlanAccountFinalization(scope, command, LegalEvidenceFinalizationPolicy{}); got.Reason != AccountFinalizationInvalidPolicy {
		t.Fatalf("invalid policy plan = %#v", got)
	}
	if got := PlanAccountFinalization(finalizationScope(t, 2), command, LegalEvidenceFinalizationPolicy{Kind: LegalEvidencePolicyUndecided}); got.Reason != AccountFinalizationScopeMismatch {
		t.Fatalf("scope mismatch plan = %#v", got)
	}
}

func TestAccountFinalizationServiceOrdersBarriersAndStopsOnPendingPolicy(t *testing.T) {
	order := make([]string, 0, 4)
	privateObjects := &finalizationGateStub{name: "private", order: &order, result: finalizationReady()}
	legal := &legalFinalizationGateStub{name: "legal", order: &order, result: retryableAccountFinalization(AccountFinalizationLegalPolicyPending)}
	wrapped := &wrappedFinalizationGateStub{name: "wrapped", order: &order, result: finalizationReady()}
	live := &liveFinalizationGateStub{name: "live", order: &order, result: confirmedAccountFinalization(AccountFinalizationDeleted)}
	scope := finalizationScope(t, 3)
	service, err := NewAccountFinalizationService(
		scope, LegalEvidenceFinalizationPolicy{Kind: LegalEvidencePolicyUndecided},
		privateObjects, legal, wrapped, live,
	)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Finalize(context.Background(), finalizationCommand(t, scope))
	if err != nil || result.Reason != AccountFinalizationLegalPolicyPending ||
		!reflect.DeepEqual(order, []string{"private", "legal"}) {
		t.Fatalf("Finalize() = %#v, %v; order = %v", result, err, order)
	}
}

func TestAccountFinalizationServiceCompletesInOrderAndRejectsMalformedGate(t *testing.T) {
	order := make([]string, 0, 4)
	privateObjects := &finalizationGateStub{name: "private", order: &order, result: finalizationReady()}
	legal := &legalFinalizationGateStub{name: "legal", order: &order, result: finalizationReady()}
	wrapped := &wrappedFinalizationGateStub{name: "wrapped", order: &order, result: finalizationReady()}
	live := &liveFinalizationGateStub{name: "live", order: &order, result: confirmedAccountFinalization(AccountFinalizationDeleted)}
	scope := finalizationScope(t, 4)
	service, err := NewAccountFinalizationService(
		scope, LegalEvidenceFinalizationPolicy{Kind: LegalEvidenceDeleteLive},
		privateObjects, legal, wrapped, live,
	)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Finalize(context.Background(), finalizationCommand(t, scope))
	if err != nil || result.Kind != AccountFinalizationConfirmed || result.Outcome != AccountFinalizationDeleted ||
		!reflect.DeepEqual(order, []string{"private", "legal", "wrapped", "live"}) {
		t.Fatalf("Finalize() = %#v, %v; order = %v", result, err, order)
	}

	privateObjects.result = retryableAccountFinalization(AccountFinalizationLiveStateRemaining)
	order = order[:0]
	result, err = service.Finalize(context.Background(), finalizationCommand(t, scope))
	if err != nil || result.Reason != AccountFinalizationPrivateObjectsUnavailable ||
		!reflect.DeepEqual(order, []string{"private"}) {
		t.Fatalf("malformed gate = %#v, %v; order = %v", result, err, order)
	}
}

func TestAccountFinalizationEffectMapsFixedCodesAndRejectsWrongStep(t *testing.T) {
	tests := []struct {
		name   string
		result AccountFinalizationResult
		err    error
		want   StepEffectResult
	}{
		{name: "success", result: confirmedAccountFinalization(AccountFinalizationDeleted), want: StepEffectResult{Kind: EffectSucceeded}},
		{name: "policy", result: retryableAccountFinalization(AccountFinalizationLegalPolicyPending), want: retryableEffect("legal-evidence-policy-pending")},
		{name: "keys", result: retryableAccountFinalization(AccountFinalizationWrappedKeysRemaining), want: retryableEffect("wrapped-key-finalization-incomplete")},
		{name: "owner", result: terminalAccountFinalization(AccountFinalizationOwnerMismatch), want: terminalEffect("account-finalization-owner-mismatch")},
		{name: "integrity", result: terminalAccountFinalization(AccountFinalizationIntegrityFailure), want: terminalEffect("account-finalization-command-rejected")},
		{name: "error", err: errors.New("unavailable"), want: retryableEffect("account-finalization-unavailable")},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			engine := &finalizationEngineStub{result: test.result, err: test.err}
			effect, err := NewAccountFinalizationEffect(engine)
			if err != nil {
				t.Fatal(err)
			}
			input := finalizationEffectInput(t)
			got, err := effect.FinalizeAccount(context.Background(), input)
			if err != nil || got != test.want || engine.command.Scope != input.Scope ||
				engine.command.OperationID != input.OperationID ||
				engine.command.PreviousReceiptAt != input.RequestedAt || engine.command.AttemptedAt != input.ExecutedAt {
				t.Fatalf("FinalizeAccount() = %#v, %v; command = %#v; want %#v", got, err, engine.command, test.want)
			}
		})
	}

	engine := &finalizationEngineStub{result: confirmedAccountFinalization(AccountFinalizationDeleted)}
	effect, _ := NewAccountFinalizationEffect(engine)
	input := finalizationEffectInput(t)
	input.Step = StepDeletePrivateObject
	got, err := effect.FinalizeAccount(context.Background(), input)
	if err != nil || got != terminalEffect("account-finalization-command-rejected") || engine.calls != 0 {
		t.Fatalf("wrong-step result = %#v, %v; calls = %d", got, err, engine.calls)
	}
}

type finalizationGateStub struct {
	name   string
	order  *[]string
	result AccountFinalizationResult
	err    error
}

func (gate *finalizationGateStub) Evaluate(
	context.Context,
	AccountFinalizationCommand,
) (AccountFinalizationResult, error) {
	*gate.order = append(*gate.order, gate.name)
	return gate.result, gate.err
}

type legalFinalizationGateStub finalizationGateStub

func (gate *legalFinalizationGateStub) EvaluateLegalEvidence(
	context.Context,
	AccountFinalizationCommand,
	LegalEvidenceFinalizationPolicy,
) (AccountFinalizationResult, error) {
	*gate.order = append(*gate.order, gate.name)
	return gate.result, gate.err
}

type wrappedFinalizationGateStub finalizationGateStub

func (gate *wrappedFinalizationGateStub) FinalizeWrappedKeys(
	context.Context,
	AccountFinalizationCommand,
	LegalEvidenceFinalizationPolicy,
) (AccountFinalizationResult, error) {
	*gate.order = append(*gate.order, gate.name)
	return gate.result, gate.err
}

type liveFinalizationGateStub finalizationGateStub

func (gate *liveFinalizationGateStub) FinalizeLiveState(
	context.Context,
	AccountFinalizationCommand,
	LegalEvidenceFinalizationPolicy,
) (AccountFinalizationResult, error) {
	*gate.order = append(*gate.order, gate.name)
	return gate.result, gate.err
}

type finalizationEngineStub struct {
	result  AccountFinalizationResult
	err     error
	command AccountFinalizationCommand
	calls   int
}

func (engine *finalizationEngineStub) Finalize(
	_ context.Context,
	command AccountFinalizationCommand,
) (AccountFinalizationResult, error) {
	engine.calls++
	engine.command = command
	return engine.result, engine.err
}

func finalizationReady() AccountFinalizationResult {
	return confirmedAccountFinalization(AccountFinalizationReady)
}

func finalizationScope(t *testing.T, suffix int) Scope {
	t.Helper()
	accountID, err := identity.ParseAccountID(finalizationTestUUID(suffix))
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID(finalizationTestUUID(suffix + 100))
	if err != nil {
		t.Fatal(err)
	}
	return Scope{AccountID: accountID, VaultID: vaultID}
}

func finalizationCommand(t *testing.T, scope Scope) AccountFinalizationCommand {
	t.Helper()
	operationID, err := ParseOperationID(finalizationTestUUID(500))
	if err != nil {
		t.Fatal(err)
	}
	return AccountFinalizationCommand{
		Scope: scope, OperationID: operationID, PreviousReceiptAt: 1_000, AttemptedAt: 1_100,
	}
}

func finalizationTestUUID(suffix int) string {
	return fmt.Sprintf("01991f20-61d2-7000-8000-%012d", suffix)
}

func finalizationEffectInput(t *testing.T) StepEffectInput {
	t.Helper()
	command := finalizationCommand(t, finalizationScope(t, 6))
	return StepEffectInput{
		Scope: command.Scope, OperationID: command.OperationID, Step: StepFinalizeAccount,
		Attempt: 1, RequestedAt: command.PreviousReceiptAt, ExecutedAt: command.AttemptedAt,
	}
}
