package entitlement

import (
	"bytes"
	"encoding/json"
	"os"
	"testing"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
)

func TestSharedEntitlementFixture(t *testing.T) {
	content, err := os.ReadFile("../../../contracts/fixtures/billing/entitlement.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture entitlementFixture
	decoder := json.NewDecoder(bytes.NewReader(content))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&fixture); err != nil || fixture.Profile != "entitlement-offline-lease-v1" {
		t.Fatalf("decode fixture = %#v, %v", fixture, err)
	}
	vaultContext := fixture.context(t)
	facts := fixture.subscriptionFacts(t)
	evaluation := EvaluateSubscriptionFacts(facts, fixture.ProjectionCheckedAt)
	if evaluation.Kind != EvaluationEvaluated || string(evaluation.State.Kind) != fixture.Expected.State ||
		evaluation.State.ValidUntil != fixture.Expected.ValidUntil {
		t.Fatalf("evaluation = %#v", evaluation)
	}
	projection := PlanProjection(vaultContext, facts, evaluation.State, fixture.ProjectionCheckedAt, nil)
	if projection.Kind != ProjectionCommit || int64(projection.Record.Version) != fixture.Expected.ProjectionVersion {
		t.Fatalf("projection = %#v", projection)
	}
	leaseID, err := ParseOfflineLeaseID(fixture.Lease.LeaseID)
	if err != nil {
		t.Fatal(err)
	}
	lease := PlanOfflineLease(
		vaultContext,
		projection.Record,
		OfflineLeasePolicy{Kind: OfflineLeaseConfigured, Duration: fixture.Lease.PolicyDuration},
		leaseID,
		fixture.Lease.IssuedAt,
	)
	if lease.Kind != OfflineLeaseIssue || string(lease.Lease.Basis) != fixture.Expected.LeaseBasis ||
		lease.Lease.ExpiresAt != fixture.Expected.LeaseExpiresAt {
		t.Fatalf("lease = %#v", lease)
	}
	boundary := AuthorizeOfflineLease(
		lease.Lease.OfflineLease, vaultContext, CapabilityNotesRead, fixture.Expected.LeaseExpiresAt,
	)
	if boundary.Kind != DecisionDenied || string(boundary.Reason) != fixture.Expected.ExpiryReason {
		t.Fatalf("boundary = %#v", boundary)
	}
	if PaidPersonalVaultLimits() != fixture.Expected.Limits {
		t.Fatalf("limits = %#v", PaidPersonalVaultLimits())
	}
}

type entitlementFixture struct {
	Profile string `json:"profile"`
	Context struct {
		AccountID    string `json:"accountId"`
		VaultID      string `json:"vaultId"`
		SessionID    string `json:"sessionId"`
		SessionEpoch int64  `json:"sessionEpoch"`
	} `json:"context"`
	Facts struct {
		SubscriptionID string `json:"subscriptionId"`
		Version        int64  `json:"version"`
		Lifecycle      struct {
			Kind           string `json:"kind"`
			TrialStartedAt int64  `json:"trialStartedAt"`
			TrialEndsAt    int64  `json:"trialEndsAt"`
		} `json:"lifecycle"`
		PaymentMethodReady bool   `json:"paymentMethodReady"`
		CancelAt           *int64 `json:"cancelAt"`
		UpdatedAt          int64  `json:"updatedAt"`
	} `json:"facts"`
	ProjectionCheckedAt int64 `json:"projectionCheckedAt"`
	Lease               struct {
		LeaseID        string `json:"leaseId"`
		IssuedAt       int64  `json:"issuedAt"`
		PolicyDuration int64  `json:"policyDuration"`
	} `json:"lease"`
	Expected struct {
		ProjectionVersion int64               `json:"projectionVersion"`
		State             string              `json:"state"`
		ValidUntil        int64               `json:"validUntil"`
		LeaseBasis        string              `json:"leaseBasis"`
		LeaseExpiresAt    int64               `json:"leaseExpiresAt"`
		ExpiryReason      string              `json:"expiryReason"`
		Limits            PersonalVaultLimits `json:"limits"`
	} `json:"expected"`
}

func (fixture entitlementFixture) context(t *testing.T) identity.VaultContext {
	t.Helper()
	accountID, accountErr := identity.ParseAccountID(fixture.Context.AccountID)
	vaultID, vaultErr := identity.ParseVaultID(fixture.Context.VaultID)
	sessionID, sessionErr := identity.ParseSessionID(fixture.Context.SessionID)
	epoch, epochErr := identity.ParseSessionEpoch(fixture.Context.SessionEpoch)
	if accountErr != nil || vaultErr != nil || sessionErr != nil || epochErr != nil {
		t.Fatal(accountErr, vaultErr, sessionErr, epochErr)
	}
	return identity.VaultContext{AccountID: accountID, VaultID: vaultID, SessionID: sessionID, SessionEpoch: epoch}
}

func (fixture entitlementFixture) subscriptionFacts(t *testing.T) billing.SubscriptionFacts {
	t.Helper()
	subscriptionID, subscriptionErr := billing.ParseSubscriptionID(fixture.Facts.SubscriptionID)
	version, versionErr := billing.ParseVersion(fixture.Facts.Version)
	vaultContext := fixture.context(t)
	if subscriptionErr != nil || versionErr != nil || fixture.Facts.Lifecycle.Kind != "trialing" {
		t.Fatal(subscriptionErr, versionErr)
	}
	return billing.SubscriptionFacts{
		SubscriptionID: subscriptionID, AccountID: vaultContext.AccountID, VaultID: vaultContext.VaultID,
		Version: version,
		Lifecycle: billing.Lifecycle{
			Kind: billing.LifecycleTrialing, TrialStartedAt: fixture.Facts.Lifecycle.TrialStartedAt,
			TrialEndsAt: fixture.Facts.Lifecycle.TrialEndsAt,
		},
		PaymentMethodReady: fixture.Facts.PaymentMethodReady,
		CancelAt:           fixture.Facts.CancelAt, UpdatedAt: fixture.Facts.UpdatedAt,
	}
}
