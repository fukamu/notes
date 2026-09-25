package operations

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/stripebilling"
)

func TestPlanBillingReconciliationDerivesProviderCommandAndReplaysExactCheckpoint(t *testing.T) {
	command := billingReconciliationCommand(t)
	record := billingReconciliationRecord(t)
	plan := PlanBillingReconciliation(command, &record, nil)
	if plan.Kind != BillingReconciliationPlanExecute || plan.Command.SubscriptionID != record.SubscriptionID ||
		plan.Command.ProviderSubscriptionReference != record.ProviderSubscriptionReference ||
		plan.Command.SnapshotID != command.SnapshotID || plan.Command.ObservedAt != command.ObservedAt ||
		plan.Command.RecordedAt != command.RecordedAt {
		t.Fatalf("execute plan = %#v", plan)
	}
	checkpoint := billingReconciliationCheckpoint(command, record)
	plan = PlanBillingReconciliation(command, &record, &checkpoint)
	if plan.Kind != BillingReconciliationPlanReplay {
		t.Fatalf("replay plan = %#v", plan)
	}
	checkpoint.RecordedAt++
	plan = PlanBillingReconciliation(command, &record, &checkpoint)
	if plan.Kind != BillingReconciliationPlanRefuse || plan.Reason != BillingReconciliationSnapshotConflict {
		t.Fatalf("conflict plan = %#v", plan)
	}
}

func TestPlanBillingReconciliationRefusesInvalidScopeAndProviderBeforeExecution(t *testing.T) {
	command := billingReconciliationCommand(t)
	record := billingReconciliationRecord(t)
	tests := []struct {
		name   string
		record *billing.SubscriptionRecord
		reason BillingReconciliationRefusal
	}{
		{name: "missing", reason: BillingReconciliationOwnerMismatch},
		{
			name: "cross owner",
			record: func() *billing.SubscriptionRecord {
				copy := record
				copy.AccountID = identity.AccountID("01991f20-61d2-7000-8000-000000009099")
				return &copy
			}(),
			reason: BillingReconciliationInvalidStoredState,
		},
		{
			name: "different provider",
			record: func() *billing.SubscriptionRecord {
				copy := record
				copy.Provider = billing.Provider("other")
				return &copy
			}(),
			reason: BillingReconciliationProviderNotLinked,
		},
		{
			name: "invalid Stripe reference",
			record: func() *billing.SubscriptionRecord {
				copy := record
				copy.ProviderSubscriptionReference = billing.ProviderSubscriptionReference("provider_reference")
				return &copy
			}(),
			reason: BillingReconciliationProviderNotLinked,
		},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			plan := PlanBillingReconciliation(command, testCase.record, nil)
			if plan.Kind != BillingReconciliationPlanRefuse || plan.Reason != testCase.reason {
				t.Fatalf("plan = %#v", plan)
			}
		})
	}
}

func TestBillingReconciliationServiceRefusesScopeAndReplaysWithoutProvider(t *testing.T) {
	command := billingReconciliationCommand(t)
	executor := &billingReconciliationExecutorStub{}
	repository := &billingReconciliationRepositoryStub{}
	service, err := NewBillingReconciliationService(repository, executor)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.Reconcile(context.Background(), command)
	if err != nil || result.Kind != BillingReconciliationRefused ||
		result.Reason != BillingReconciliationOwnerMismatch || repository.checkpointCalls != 0 || executor.calls != 0 {
		t.Fatalf("refused = %#v, %v; repository = %#v; executor = %#v", result, err, repository, executor)
	}

	record := billingReconciliationRecord(t)
	repository.record = &record
	repository.checkpoint = pointerBillingCheckpoint(billingReconciliationCheckpoint(command, record))
	result, err = service.Reconcile(context.Background(), command)
	if err != nil || result.Kind != BillingReconciliationReplayed || executor.calls != 0 ||
		repository.checkpointCalls != 1 {
		t.Fatalf("replayed = %#v, %v; repository = %#v; executor = %#v", result, err, repository, executor)
	}
}

func TestBillingReconciliationServiceMapsOnlyAcceptedOutcomes(t *testing.T) {
	command := billingReconciliationCommand(t)
	record := billingReconciliationRecord(t)
	tests := []struct {
		name   string
		result stripebilling.WebhookResult
		want   BillingReconciliationResultKind
		failed bool
	}{
		{name: "applied", result: acceptedBillingResult(billing.ResultApplied), want: BillingReconciliationApplied},
		{name: "ignored", result: acceptedBillingResult(billing.ResultIgnored), want: BillingReconciliationIgnored},
		{name: "concurrent duplicate", result: acceptedBillingResult(billing.ResultDuplicate), want: BillingReconciliationReplayed},
		{name: "provider failure", result: stripebilling.WebhookResult{Kind: stripebilling.WebhookRejected, Reason: stripebilling.ReasonProviderUnavailable}, failed: true},
		{name: "unexpected outcome", result: acceptedBillingResult(billing.ResultRejected), failed: true},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			repository := &billingReconciliationRepositoryStub{record: &record}
			executor := &billingReconciliationExecutorStub{result: testCase.result}
			service, _ := NewBillingReconciliationService(repository, executor)
			result, err := service.Reconcile(context.Background(), command)
			if testCase.failed {
				if !errors.Is(err, ErrBillingReconciliation) || result != (BillingReconciliationResult{}) {
					t.Fatalf("result = %#v, err = %v", result, err)
				}
				return
			}
			if err != nil || result.Kind != testCase.want || result.SnapshotID != command.SnapshotID || executor.calls != 1 ||
				executor.command.SubscriptionID != record.SubscriptionID {
				t.Fatalf("result = %#v, err = %v, executor = %#v", result, err, executor)
			}
		})
	}
}

func TestValidateBillingReconciliationCommandAndDependencies(t *testing.T) {
	valid := billingReconciliationCommand(t)
	tests := []BillingReconciliationCommand{
		{},
		func() BillingReconciliationCommand { value := valid; value.ObservedAt = 0; return value }(),
		func() BillingReconciliationCommand {
			value := valid
			value.RecordedAt = value.ObservedAt - 1
			return value
		}(),
		func() BillingReconciliationCommand { value := valid; value.SnapshotID = "bad snapshot"; return value }(),
	}
	for _, command := range tests {
		if ValidateBillingReconciliationCommand(command) == nil {
			t.Fatalf("accepted command = %#v", command)
		}
	}
	if _, err := NewBillingReconciliationService(nil, &billingReconciliationExecutorStub{}); !errors.Is(err, ErrBillingReconciliation) {
		t.Fatalf("nil repository error = %v", err)
	}
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	repository := &billingReconciliationRepositoryStub{checkContext: true}
	service, _ := NewBillingReconciliationService(repository, &billingReconciliationExecutorStub{})
	if _, err := service.Reconcile(cancelled, valid); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled error = %v", err)
	}
}

type billingReconciliationRepositoryStub struct {
	record          *billing.SubscriptionRecord
	checkpoint      *billing.ReconciliationCheckpoint
	err             error
	checkContext    bool
	checkpointCalls int
}

func (stub *billingReconciliationRepositoryStub) FindByOwner(
	ctx context.Context,
	_ billing.OwnerScope,
) (*billing.SubscriptionRecord, error) {
	if stub.checkContext {
		return nil, ctx.Err()
	}
	return stub.record, stub.err
}

func (stub *billingReconciliationRepositoryStub) FindReconciliationCheckpoint(
	context.Context,
	billing.Provider,
	billing.ReconciliationSnapshotID,
) (*billing.ReconciliationCheckpoint, error) {
	stub.checkpointCalls++
	return stub.checkpoint, stub.err
}

type billingReconciliationExecutorStub struct {
	result  stripebilling.WebhookResult
	calls   int
	command stripebilling.ReconciliationCommand
}

func (stub *billingReconciliationExecutorStub) ReconcileSubscription(
	_ context.Context,
	command stripebilling.ReconciliationCommand,
) stripebilling.WebhookResult {
	stub.calls++
	stub.command = command
	return stub.result
}

func billingReconciliationCommand(t *testing.T) BillingReconciliationCommand {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000009010")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000009011")
	snapshotID, _ := billing.ParseReconciliationSnapshotID("manual-2026-09-26T00:00:00Z")
	return BillingReconciliationCommand{
		AccountID: accountID, VaultID: vaultID, SnapshotID: snapshotID,
		ObservedAt: 5_000, RecordedAt: 5_100,
	}
}

func billingReconciliationRecord(t *testing.T) billing.SubscriptionRecord {
	t.Helper()
	command := billingReconciliationCommand(t)
	subscriptionID, _ := billing.ParseSubscriptionID("01991f20-61d2-7000-8000-000000009012")
	return billing.SubscriptionRecord{
		SubscriptionID: subscriptionID, AccountID: command.AccountID, VaultID: command.VaultID,
		Provider: stripebilling.Provider, ProviderCustomerReference: "cus_FukamuA",
		ProviderSubscriptionReference: "sub_FukamuA", Version: 1,
		Lifecycle: billing.Lifecycle{Kind: billing.LifecycleCheckoutPending}, CreatedAt: 1_000, UpdatedAt: 1_000,
	}
}

func billingReconciliationCheckpoint(
	command BillingReconciliationCommand,
	record billing.SubscriptionRecord,
) billing.ReconciliationCheckpoint {
	return billing.ReconciliationCheckpoint{
		Provider: stripebilling.Provider, SnapshotID: command.SnapshotID,
		SubscriptionID: record.SubscriptionID, ObservedAt: command.ObservedAt,
		AppliedVersion: record.Version, RecordedAt: command.RecordedAt,
	}
}

func acceptedBillingResult(kind billing.CommandResultKind) stripebilling.WebhookResult {
	return stripebilling.WebhookResult{Kind: stripebilling.WebhookAccepted, Outcome: kind}
}

func pointerBillingCheckpoint(value billing.ReconciliationCheckpoint) *billing.ReconciliationCheckpoint {
	return &value
}
