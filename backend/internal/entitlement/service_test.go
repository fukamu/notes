package entitlement

import (
	"context"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
)

func TestServiceOwnershipAndRecoveryFailurePolicy(t *testing.T) {
	facts := trialFacts()
	repository := newFakeRepository()
	service, err := NewService(&billingStub{facts: &facts}, ownershipStub{owned: false}, repository, FukamuOfflineLeasePolicy())
	if err != nil {
		t.Fatal(err)
	}
	if decision := service.AuthorizeCapability(context.Background(), testContext(), CapabilityBillingRecovery, 3_000); decision.Reason != DenialOwnerMismatch {
		t.Fatalf("owner mismatch = %#v", decision)
	}

	missing, _ := NewService(&billingStub{}, ownershipStub{owned: true}, repository, FukamuOfflineLeasePolicy())
	if decision := missing.AuthorizeCapability(context.Background(), testContext(), CapabilityNotesRead, 3_000); decision.Reason != DenialSubscriptionRequired {
		t.Fatalf("missing content = %#v", decision)
	}
	if decision := missing.AuthorizeCapability(context.Background(), testContext(), CapabilityAccountDelete, 3_000); decision.Kind != DecisionAllowed || decision.Basis != BasisRecovery {
		t.Fatalf("missing recovery = %#v", decision)
	}

	unavailable, _ := NewService(&billingStub{err: errTestUnavailable}, ownershipStub{owned: true}, repository, FukamuOfflineLeasePolicy())
	if decision := unavailable.AuthorizeCapability(context.Background(), testContext(), CapabilityNotesSync, 3_000); decision.Reason != DenialBillingUnavailable {
		t.Fatalf("unavailable content = %#v", decision)
	}
	if decision := unavailable.AuthorizeCapability(context.Background(), testContext(), CapabilityBillingRecovery, 3_000); decision.Kind != DecisionAllowed {
		t.Fatalf("unavailable recovery = %#v", decision)
	}
}

func TestServiceLimitsLeaseReplayRevocationAndStrictlyNewerPaidFact(t *testing.T) {
	facts := trialFacts()
	billingPort := &billingStub{facts: &facts}
	repository := newFakeRepository()
	service, err := NewService(billingPort, ownershipStub{owned: true}, repository, FukamuOfflineLeasePolicy())
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	if limits := service.ReadLimits(ctx, testContext(), 3_000); limits.Kind != LimitsAvailable || limits.Limits.ActiveCards != 10_000 {
		t.Fatalf("limits = %#v", limits)
	}
	issued := service.IssueOfflineLease(ctx, testContext(), testLeaseA, 3_100)
	if issued.Kind != LeaseIssued || issued.Lease == nil || issued.Lease.Basis != BasisTrial {
		t.Fatalf("issued = %#v", issued)
	}
	if replayed := service.IssueOfflineLease(ctx, testContext(), testLeaseA, 3_100); replayed.Kind != LeaseReplayed {
		t.Fatalf("replayed = %#v", replayed)
	}
	if conflict := service.IssueOfflineLease(ctx, testContext(), testLeaseA, 3_101); conflict.Reason != DenialIdentifierConflict {
		t.Fatalf("identifier conflict = %#v", conflict)
	}

	failed := testFacts(billing.Lifecycle{
		Kind: billing.LifecycleDelinquent, DelinquencyReason: billing.DelinquencyPaymentFailed,
		DelinquencySince: 5_000, InvoiceReference: "in_failed",
	})
	failed.Version = 3
	failed.UpdatedAt = 5_000
	billingPort.facts = &failed
	if decision := service.AuthorizeCapability(ctx, testContext(), CapabilityNotesRead, 5_001); decision.Reason != DenialReason(LockPaymentFailed) {
		t.Fatalf("failed online = %#v", decision)
	}
	if decision := service.AuthorizeOfflineCapability(ctx, testContext(), CapabilityNotesRead, testLeaseA, 5_002); decision.Reason != DenialLeaseRevoked {
		t.Fatalf("failed offline = %#v", decision)
	}

	olderPaid := testFacts(billing.Lifecycle{Kind: billing.LifecycleActive, PaidPeriodStartedAt: 4_000, PaidThrough: 20_000})
	olderPaid.Version = 2
	olderPaid.UpdatedAt = 4_000
	billingPort.facts = &olderPaid
	if decision := service.AuthorizeCapability(ctx, testContext(), CapabilityNotesRead, 5_003); decision.Reason != DenialProjectionConflict {
		t.Fatalf("older paid = %#v", decision)
	}
	newerPaid := olderPaid
	newerPaid.Version = 4
	newerPaid.UpdatedAt = 7_000
	newerPaid.Lifecycle.PaidPeriodStartedAt = 7_000
	newerPaid.Lifecycle.PaidThrough = 7_000 + OfflineLeaseDurationMilliseconds*2
	billingPort.facts = &newerPaid
	if decision := service.AuthorizeCapability(ctx, testContext(), CapabilityNotesRead, 7_001); decision.Kind != DecisionAllowed || decision.Basis != BasisPaid {
		t.Fatalf("newer paid = %#v", decision)
	}
}

func TestServiceRetriesOneProjectionCASConflict(t *testing.T) {
	facts := trialFacts()
	repository := newFakeRepository()
	repository.commitConflicts = 1
	service, err := NewService(&billingStub{facts: &facts}, ownershipStub{owned: true}, repository, FukamuOfflineLeasePolicy())
	if err != nil {
		t.Fatal(err)
	}
	decision := service.AuthorizeCapability(context.Background(), testContext(), CapabilityNotesWrite, 3_000)
	if decision.Kind != DecisionAllowed || decision.Basis != BasisTrial {
		t.Fatalf("retry = %#v", decision)
	}
	repository.commitConflicts = 2
	decision = service.AuthorizeCapability(context.Background(), testContext(), CapabilityNotesWrite, 3_001)
	if decision.Reason != DenialProjectionConflict {
		t.Fatalf("retry exhausted = %#v", decision)
	}
}

func TestServiceFailClosedOnRepositoryFailures(t *testing.T) {
	facts := trialFacts()
	repository := newFakeRepository()
	repository.findErr = errTestUnavailable
	service, _ := NewService(&billingStub{facts: &facts}, ownershipStub{owned: true}, repository, FukamuOfflineLeasePolicy())
	if decision := service.AuthorizeCapability(context.Background(), testContext(), CapabilityNotesRead, 3_000); decision.Reason != DenialEntitlementUnavailable {
		t.Fatalf("find failure = %#v", decision)
	}
	repository.findErr = nil
	repository.commitErr = errTestUnavailable
	if decision := service.AuthorizeCapability(context.Background(), testContext(), CapabilityNotesRead, 3_000); decision.Reason != DenialEntitlementUnavailable {
		t.Fatalf("commit failure = %#v", decision)
	}
}
