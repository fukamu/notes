package billing

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/identity"
)

var errBillingDependency = errors.New("billing dependency failure")

func TestServiceRejectsOwnerMismatchBeforeRepositoryAccess(t *testing.T) {
	repository := &billingRepositoryStub{}
	service, err := NewService(ownershipStub{owned: false}, repository)
	if err != nil {
		t.Fatal(err)
	}
	result, err := service.BeginCheckout(context.Background(), vaultContext(t), checkoutCommand())
	if err != nil || result.Kind != ResultRejected || result.Reason != ResultOwnerMismatch || repository.calls != 0 {
		t.Fatalf("owner rejection = %#v, %v calls=%d", result, err, repository.calls)
	}
}

func TestServiceCommitsVerifiedFactAndHandlesLostResponseDuplicate(t *testing.T) {
	current := checkoutRecord(t)
	fact := providerFact(FactTrialStarted, 2_000)
	repository := &billingRepositoryStub{record: &current, commitKind: CommitApplied}
	service, _ := NewService(ownershipStub{owned: true}, repository)
	result, err := service.IngestVerifiedProviderFact(context.Background(), fact)
	if err != nil || result.Kind != ResultApplied || result.Facts == nil || result.Facts.Version != 2 || repository.commitCalls != 1 {
		t.Fatalf("fact ingestion = %#v, %v commits=%d", result, err, repository.commitCalls)
	}

	repository.receipt = &ProviderEventReceipt{
		Provider: fact.Provider, EventID: fact.EventID, SubscriptionID: fact.SubscriptionID,
		FactKind: fact.Kind, Outcome: ReceiptApplied, OccurredAt: fact.OccurredAt, AppliedVersion: 2, RecordedAt: fact.RecordedAt,
	}
	repository.commitCalls = 0
	duplicate, err := service.IngestVerifiedProviderFact(context.Background(), fact)
	if err != nil || duplicate.Kind != ResultDuplicate || repository.commitCalls != 0 {
		t.Fatalf("duplicate ingestion = %#v, %v commits=%d", duplicate, err, repository.commitCalls)
	}
}

func TestServiceFailsClosedOnProviderMappingAndCASConflict(t *testing.T) {
	current := checkoutRecord(t)
	other := current
	other.SubscriptionID = "01991f20-61d2-7000-8000-000000000799"
	repository := &billingRepositoryStub{record: &current, mapped: &other, commitKind: CommitConflict}
	service, _ := NewService(ownershipStub{owned: true}, repository)
	result, err := service.IngestVerifiedProviderFact(context.Background(), providerFact(FactInvoicePaid, 5_000))
	if err != nil || result.Kind != ResultRejected || result.Reason != ResultMappingMismatch || repository.commitCalls != 0 {
		t.Fatalf("mapping mismatch = %#v, %v", result, err)
	}

	repository.mapped = nil
	result, err = service.IngestVerifiedProviderFact(context.Background(), providerFact(FactInvoicePaid, 5_000))
	if err != nil || result.Kind != ResultRejected || result.Reason != ResultCASConflict || repository.commitCalls != 1 {
		t.Fatalf("CAS conflict = %#v, %v commits=%d", result, err, repository.commitCalls)
	}
}

func TestServicePropagatesDependencyFailureWithoutGrantingFacts(t *testing.T) {
	service, _ := NewService(ownershipStub{err: errBillingDependency}, &billingRepositoryStub{})
	result, err := service.ReadSubscription(context.Background(), vaultContext(t))
	if !errors.Is(err, errBillingDependency) || result != nil {
		t.Fatalf("dependency failure = %#v, %v", result, err)
	}
}

type ownershipStub struct {
	owned bool
	err   error
}

func (stub ownershipStub) Owns(context.Context, identity.VaultContext) (bool, error) {
	return stub.owned, stub.err
}

type billingRepositoryStub struct {
	record      *SubscriptionRecord
	mapped      *SubscriptionRecord
	receipt     *ProviderEventReceipt
	checkpoint  *ReconciliationCheckpoint
	commitKind  CommitKind
	calls       int
	commitCalls int
}

func (stub *billingRepositoryStub) FindByOwner(context.Context, OwnerScope) (*SubscriptionRecord, error) {
	stub.calls++
	return stub.record, nil
}

func (stub *billingRepositoryStub) FindByID(context.Context, SubscriptionID) (*SubscriptionRecord, error) {
	stub.calls++
	return stub.record, nil
}

func (stub *billingRepositoryStub) FindByProviderMapping(
	context.Context,
	Provider,
	ProviderCustomerReference,
	ProviderSubscriptionReference,
) (*SubscriptionRecord, error) {
	stub.calls++
	return stub.mapped, nil
}

func (stub *billingRepositoryStub) FindCheckoutIntent(context.Context, CheckoutIntentID) (*CheckoutIntentRecord, error) {
	stub.calls++
	return nil, nil
}

func (stub *billingRepositoryStub) FindCheckoutByProviderReference(
	context.Context,
	Provider,
	ProviderCheckoutReference,
) (*CheckoutIntentRecord, error) {
	stub.calls++
	return nil, nil
}

func (stub *billingRepositoryStub) CreateCheckout(
	context.Context,
	SubscriptionRecord,
	CheckoutIntentRecord,
) (CheckoutCreateResult, error) {
	stub.calls++
	return CheckoutCreateResult{Kind: CheckoutCreated}, nil
}

func (stub *billingRepositoryStub) OpenCheckout(
	context.Context,
	OwnerScope,
	CheckoutIntentRecord,
) (CommitKind, error) {
	stub.calls++
	return stub.commitKind, nil
}

func (stub *billingRepositoryStub) FindProviderEventReceipt(
	context.Context,
	Provider,
	ProviderEventID,
) (*ProviderEventReceipt, error) {
	stub.calls++
	return stub.receipt, nil
}

func (stub *billingRepositoryStub) CommitProviderFact(
	context.Context,
	SubscriptionRecord,
	SubscriptionRecord,
	ProviderEventReceipt,
) (CommitKind, error) {
	stub.calls++
	stub.commitCalls++
	return stub.commitKind, nil
}

func (stub *billingRepositoryStub) RecordIgnoredProviderFact(
	context.Context,
	ProviderEventReceipt,
) (CommitKind, error) {
	stub.calls++
	return stub.commitKind, nil
}

func (stub *billingRepositoryStub) FindReconciliationCheckpoint(
	context.Context,
	Provider,
	ReconciliationSnapshotID,
) (*ReconciliationCheckpoint, error) {
	stub.calls++
	return stub.checkpoint, nil
}

func (stub *billingRepositoryStub) CommitReconciliation(
	context.Context,
	SubscriptionRecord,
	SubscriptionRecord,
	ReconciliationCheckpoint,
) (CommitKind, error) {
	stub.calls++
	stub.commitCalls++
	return stub.commitKind, nil
}

func (stub *billingRepositoryStub) RecordIgnoredReconciliation(
	context.Context,
	ReconciliationCheckpoint,
) (CommitKind, error) {
	stub.calls++
	return stub.commitKind, nil
}

func vaultContext(t *testing.T) identity.VaultContext {
	t.Helper()
	scope := ownerScope(t)
	sessionID, err := identity.ParseSessionID("01991f20-61d2-7000-8000-000000000301")
	if err != nil {
		t.Fatal(err)
	}
	return identity.VaultContext{AccountID: scope.AccountID, VaultID: scope.VaultID, SessionID: sessionID, SessionEpoch: 1}
}
