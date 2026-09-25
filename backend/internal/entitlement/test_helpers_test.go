package entitlement

import (
	"context"
	"errors"
	"sync"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
)

const (
	testAccountID      = identity.AccountID("01991f20-61d2-7000-8000-000000000101")
	testVaultID        = identity.VaultID("01991f20-61d2-7000-8000-000000000201")
	testSessionID      = identity.SessionID("01991f20-61d2-7000-8000-000000000301")
	testSubscriptionID = billing.SubscriptionID("01991f20-61d2-7000-8000-000000000701")
	testLeaseA         = OfflineLeaseID("01991f20-61d2-7000-8000-000000001801")
	testLeaseB         = OfflineLeaseID("01991f20-61d2-7000-8000-000000001802")
)

func testContext() identity.VaultContext {
	return identity.VaultContext{AccountID: testAccountID, VaultID: testVaultID, SessionID: testSessionID, SessionEpoch: 1}
}

func testFacts(lifecycle billing.Lifecycle) billing.SubscriptionFacts {
	return billing.SubscriptionFacts{
		SubscriptionID: testSubscriptionID, AccountID: testAccountID, VaultID: testVaultID,
		Version: 2, Lifecycle: lifecycle, PaymentMethodReady: true, UpdatedAt: 2_000,
	}
}

func trialFacts() billing.SubscriptionFacts {
	return testFacts(billing.Lifecycle{
		Kind: billing.LifecycleTrialing, TrialStartedAt: 2_000,
		TrialEndsAt: 2_000 + billing.TrialDurationMilliseconds,
	})
}

type billingStub struct {
	facts *billing.SubscriptionFacts
	err   error
}

func (stub *billingStub) ReadSubscription(context.Context, identity.VaultContext) (*billing.SubscriptionFacts, error) {
	if stub.err != nil {
		return nil, stub.err
	}
	if stub.facts == nil {
		return nil, nil
	}
	copy := *stub.facts
	if stub.facts.CancelAt != nil {
		value := *stub.facts.CancelAt
		copy.CancelAt = &value
	}
	return &copy, nil
}

type ownershipStub struct {
	owned bool
	err   error
}

func (stub ownershipStub) Owns(context.Context, identity.VaultContext) (bool, error) {
	return stub.owned, stub.err
}

type fakeRepository struct {
	mu              sync.Mutex
	projection      *ProjectionRecord
	leases          map[OfflineLeaseID]OfflineLeaseRecord
	findErr         error
	commitErr       error
	createErr       error
	commitConflicts int
}

func newFakeRepository() *fakeRepository {
	return &fakeRepository{leases: make(map[OfflineLeaseID]OfflineLeaseRecord)}
}

func (repository *fakeRepository) FindProjection(context.Context, identity.VaultContext) (*ProjectionRecord, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	if repository.findErr != nil {
		return nil, repository.findErr
	}
	if repository.projection == nil {
		return nil, nil
	}
	copy := *repository.projection
	return &copy, nil
}

func (repository *fakeRepository) CommitProjection(
	_ context.Context,
	expected *ProjectionVersion,
	record ProjectionRecord,
	revokeAt *int64,
) (ProjectionCommitKind, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	if repository.commitErr != nil {
		return "", repository.commitErr
	}
	if repository.commitConflicts > 0 {
		repository.commitConflicts--
		return ProjectionConflict, nil
	}
	if expected == nil {
		if repository.projection != nil {
			return ProjectionConflict, nil
		}
	} else if repository.projection == nil || repository.projection.Version != *expected {
		return ProjectionConflict, nil
	}
	repository.projection = &record
	if revokeAt != nil {
		for id, lease := range repository.leases {
			if lease.Context.AccountID == record.AccountID && lease.Context.VaultID == record.VaultID &&
				lease.RevokedAt == nil && lease.IssuedAt <= *revokeAt {
				lease.RevokedAt = pointer(*revokeAt)
				repository.leases[id] = lease
			}
		}
	}
	return ProjectionApplied, nil
}

func (repository *fakeRepository) FindOfflineLease(
	_ context.Context,
	vaultContext identity.VaultContext,
	leaseID OfflineLeaseID,
) (*OfflineLeaseRecord, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	if repository.findErr != nil {
		return nil, repository.findErr
	}
	lease, ok := repository.leases[leaseID]
	if !ok || lease.Context.AccountID != vaultContext.AccountID || lease.Context.VaultID != vaultContext.VaultID {
		return nil, nil
	}
	return &lease, nil
}

func (repository *fakeRepository) CreateOfflineLease(
	_ context.Context,
	expected ProjectionVersion,
	lease OfflineLeaseRecord,
) (LeaseCreateResult, error) {
	repository.mu.Lock()
	defer repository.mu.Unlock()
	if repository.createErr != nil {
		return LeaseCreateResult{}, repository.createErr
	}
	if existing, ok := repository.leases[lease.LeaseID]; ok {
		if sameLeaseRecord(existing, lease) {
			return LeaseCreateResult{Kind: LeaseCreateReplayed, Lease: &existing}, nil
		}
		return LeaseCreateResult{Kind: LeaseCreateIdentifierConflict}, nil
	}
	if repository.projection == nil || repository.projection.Version != expected ||
		repository.projection.SourceSubscriptionID != lease.SourceSubscriptionID ||
		repository.projection.SourceBillingVersion != lease.SourceBillingVersion ||
		repository.projection.State.Kind == StateLocked || repository.projection.State.ValidUntil < lease.ExpiresAt {
		return LeaseCreateResult{Kind: LeaseCreateProjectionConflict}, nil
	}
	repository.leases[lease.LeaseID] = lease
	return LeaseCreateResult{Kind: LeaseCreateIssued}, nil
}

func sameLeaseRecord(left OfflineLeaseRecord, right OfflineLeaseRecord) bool {
	return left.LeaseID == right.LeaseID && sameContext(left.Context, right.Context) &&
		left.SourceSubscriptionID == right.SourceSubscriptionID && left.SourceBillingVersion == right.SourceBillingVersion &&
		left.Basis == right.Basis && left.IssuedAt == right.IssuedAt && left.ExpiresAt == right.ExpiresAt &&
		((left.RevokedAt == nil && right.RevokedAt == nil) ||
			(left.RevokedAt != nil && right.RevokedAt != nil && *left.RevokedAt == *right.RevokedAt))
}

var errTestUnavailable = errors.New("unavailable")
