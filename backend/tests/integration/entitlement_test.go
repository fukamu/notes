//go:build integration

package integration_test

import (
	"context"
	"errors"
	"sync"
	"testing"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestEntitlementLifecyclePostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultContext := seedEntitlementOwner(t, ctx, pool, 101, 201, 301)
	otherContext := seedEntitlementOwner(t, ctx, pool, 102, 202, 302)
	billingService, entitlementService, _, _ := entitlementModules(t, pool)
	facts := startEntitlementTrial(t, ctx, billingService, vaultContext, 701, 702, "evt_trial_a")

	decision := entitlementService.AuthorizeCapability(ctx, vaultContext, entitlement.CapabilityNotesWrite, 3_000)
	if decision.Kind != entitlement.DecisionAllowed || decision.Basis != entitlement.BasisTrial {
		t.Fatalf("trial access = %#v", decision)
	}
	limits := entitlementService.ReadLimits(ctx, vaultContext, 3_000)
	if limits.Kind != entitlement.LimitsAvailable || limits.Limits.ActiveCards != 10_000 {
		t.Fatalf("limits = %#v", limits)
	}
	leaseID, _ := entitlement.ParseOfflineLeaseID(integrationUUID(t, 801))
	issued := entitlementService.IssueOfflineLease(ctx, vaultContext, leaseID, 3_100)
	if issued.Kind != entitlement.LeaseIssued || issued.Lease == nil {
		t.Fatalf("issue lease = %#v", issued)
	}
	if replayed := entitlementService.IssueOfflineLease(ctx, vaultContext, leaseID, 3_100); replayed.Kind != entitlement.LeaseReplayed {
		t.Fatalf("replay lease = %#v", replayed)
	}
	if crossOwner := entitlementService.AuthorizeOfflineCapability(ctx, otherContext, entitlement.CapabilityNotesRead, leaseID, 3_200); crossOwner.Kind != entitlement.DecisionDenied || crossOwner.Reason != entitlement.DenialLeaseNotFound {
		t.Fatalf("cross-owner lease = %#v", crossOwner)
	}
	if atExpiry := entitlementService.AuthorizeOfflineCapability(
		ctx, vaultContext, entitlement.CapabilityNotesWrite, leaseID, issued.Lease.ExpiresAt,
	); atExpiry.Reason != entitlement.DenialLeaseExpired {
		t.Fatalf("exact expiry = %#v", atExpiry)
	}

	failed := integrationProviderFact(facts.SubscriptionID, billing.FactInvoicePaymentFailed, "evt_failed_a", 5_000)
	if result, err := billingService.IngestVerifiedProviderFact(ctx, failed); err != nil || result.Kind != billing.ResultApplied {
		t.Fatalf("payment failure = %#v, %v", result, err)
	}
	if locked := entitlementService.AuthorizeCapability(ctx, vaultContext, entitlement.CapabilityNotesSync, 5_001); locked.Reason != entitlement.DenialReason(entitlement.LockPaymentFailed) {
		t.Fatalf("online lock = %#v", locked)
	}
	if revoked := entitlementService.AuthorizeOfflineCapability(ctx, vaultContext, entitlement.CapabilityNotesRead, leaseID, 5_002); revoked.Reason != entitlement.DenialLeaseRevoked {
		t.Fatalf("offline revocation = %#v", revoked)
	}

	olderPaid := integrationProviderFact(facts.SubscriptionID, billing.FactInvoicePaid, "evt_old_paid_a", 4_000)
	if result, err := billingService.IngestVerifiedProviderFact(ctx, olderPaid); err != nil || result.Kind != billing.ResultApplied {
		t.Fatalf("older paid fact = %#v, %v", result, err)
	}
	if stillLocked := entitlementService.AuthorizeCapability(ctx, vaultContext, entitlement.CapabilityNotesRead, 5_003); stillLocked.Reason != entitlement.DenialReason(entitlement.LockPaymentFailed) {
		t.Fatalf("old paid unlock = %#v", stillLocked)
	}
	newerPaid := integrationProviderFact(facts.SubscriptionID, billing.FactInvoicePaid, "evt_new_paid_a", 7_000)
	if result, err := billingService.IngestVerifiedProviderFact(ctx, newerPaid); err != nil || result.Kind != billing.ResultApplied {
		t.Fatalf("new paid fact = %#v, %v", result, err)
	}
	if active := entitlementService.AuthorizeCapability(ctx, vaultContext, entitlement.CapabilityNotesRead, 7_001); active.Kind != entitlement.DecisionAllowed || active.Basis != entitlement.BasisPaid {
		t.Fatalf("new paid access = %#v", active)
	}
	assertEntitlementSchema(t, ctx, pool)
}

func TestEntitlementLeaseIssuanceAndLockAreAtomicPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultContext := seedEntitlementOwner(t, ctx, pool, 111, 211, 311)
	billingService, entitlementService, _, store := entitlementModules(t, pool)
	facts := startEntitlementTrial(t, ctx, billingService, vaultContext, 711, 712, "evt_trial_atomic")
	if decision := entitlementService.AuthorizeCapability(ctx, vaultContext, entitlement.CapabilityNotesRead, 3_000); decision.Kind != entitlement.DecisionAllowed {
		t.Fatalf("create projection = %#v", decision)
	}
	current, err := store.FindProjection(ctx, vaultContext)
	if err != nil || current == nil {
		t.Fatalf("find projection = %#v, %v", current, err)
	}
	leaseID, _ := entitlement.ParseOfflineLeaseID(integrationUUID(t, 811))
	leasePlan := entitlement.PlanOfflineLease(vaultContext, *current, entitlement.FukamuOfflineLeasePolicy(), leaseID, 3_100)
	if leasePlan.Kind != entitlement.OfflineLeaseIssue {
		t.Fatalf("lease plan = %#v", leasePlan)
	}
	failedFacts := *facts
	failedFacts.Version++
	failedFacts.Lifecycle = billing.Lifecycle{
		Kind: billing.LifecycleDelinquent, DelinquencyReason: billing.DelinquencyPaymentFailed,
		DelinquencySince: 5_000, InvoiceReference: "in_atomic",
	}
	failedFacts.UpdatedAt = 5_000
	evaluation := entitlement.EvaluateSubscriptionFacts(failedFacts, 5_001)
	lockPlan := entitlement.PlanProjection(vaultContext, failedFacts, evaluation.State, 5_001, current)
	if lockPlan.Kind != entitlement.ProjectionCommit {
		t.Fatalf("lock plan = %#v", lockPlan)
	}

	type result struct {
		kind string
		err  error
	}
	results := make(chan result, 2)
	var start sync.WaitGroup
	start.Add(1)
	go func() {
		start.Wait()
		created, createErr := store.CreateOfflineLease(ctx, current.Version, leasePlan.Lease)
		results <- result{kind: string(created.Kind), err: createErr}
	}()
	go func() {
		start.Wait()
		expected := current.Version
		committed, commitErr := store.CommitProjection(ctx, &expected, lockPlan.Record, pointerForIntegration(5_001))
		results <- result{kind: string(committed), err: commitErr}
	}()
	start.Done()
	for range 2 {
		outcome := <-results
		if outcome.err != nil {
			t.Fatalf("concurrent outcome %q = %v", outcome.kind, outcome.err)
		}
	}
	projection, err := store.FindProjection(ctx, vaultContext)
	if err != nil || projection == nil || projection.State.Kind != entitlement.StateLocked {
		t.Fatalf("final projection = %#v, %v", projection, err)
	}
	lease, err := store.FindOfflineLease(ctx, vaultContext, leaseID)
	if err != nil {
		t.Fatal(err)
	}
	if lease != nil && (lease.RevokedAt == nil || *lease.RevokedAt != 5_001) {
		t.Fatalf("active lease survived locked projection = %#v", lease)
	}
}

func TestEntitlementLockRollbackAndMalformedRowsFailClosedPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultContext := seedEntitlementOwner(t, ctx, pool, 121, 221, 321)
	billingService, entitlementService, _, store := entitlementModules(t, pool)
	facts := startEntitlementTrial(t, ctx, billingService, vaultContext, 721, 722, "evt_trial_rollback")
	if decision := entitlementService.AuthorizeCapability(ctx, vaultContext, entitlement.CapabilityNotesRead, 3_000); decision.Kind != entitlement.DecisionAllowed {
		t.Fatalf("create projection = %#v", decision)
	}
	leaseID, _ := entitlement.ParseOfflineLeaseID(integrationUUID(t, 821))
	if issued := entitlementService.IssueOfflineLease(ctx, vaultContext, leaseID, 3_100); issued.Kind != entitlement.LeaseIssued {
		t.Fatalf("issue lease = %#v", issued)
	}
	if _, err := pool.Exec(ctx, `CREATE FUNCTION fail_entitlement_revoke() RETURNS trigger
		LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'lease revoke failure'; END $$`); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `CREATE TRIGGER fail_entitlement_revoke
		BEFORE UPDATE OF revoked_at ON entitlement_offline_leases
		FOR EACH ROW EXECUTE FUNCTION fail_entitlement_revoke()`); err != nil {
		t.Fatal(err)
	}
	failed := integrationProviderFact(facts.SubscriptionID, billing.FactInvoicePaymentFailed, "evt_failed_rollback", 5_000)
	if result, err := billingService.IngestVerifiedProviderFact(ctx, failed); err != nil || result.Kind != billing.ResultApplied {
		t.Fatalf("payment failure = %#v, %v", result, err)
	}
	if decision := entitlementService.AuthorizeCapability(ctx, vaultContext, entitlement.CapabilityNotesRead, 5_001); decision.Reason != entitlement.DenialEntitlementUnavailable {
		t.Fatalf("revoke failure = %#v", decision)
	}
	projection, err := store.FindProjection(ctx, vaultContext)
	if err != nil || projection == nil || projection.State.Kind != entitlement.StateTrialActive {
		t.Fatalf("projection rollback = %#v, %v", projection, err)
	}
	lease, err := store.FindOfflineLease(ctx, vaultContext, leaseID)
	if err != nil || lease == nil || lease.RevokedAt != nil {
		t.Fatalf("lease rollback = %#v, %v", lease, err)
	}
	if _, err := pool.Exec(ctx, "DROP TRIGGER fail_entitlement_revoke ON entitlement_offline_leases"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "DROP FUNCTION fail_entitlement_revoke()"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "ALTER TABLE entitlement_projections DROP CONSTRAINT entitlement_projection_shape_check"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(
		ctx,
		"UPDATE entitlement_projections SET state = 'paid-active', valid_until = NULL WHERE account_id = $1 AND vault_id = $2",
		string(vaultContext.AccountID), string(vaultContext.VaultID),
	); err != nil {
		t.Fatal(err)
	}
	if _, err := store.FindProjection(ctx, vaultContext); !errors.Is(err, postgresadapter.ErrInvalidEntitlementRecord) {
		t.Fatalf("malformed projection error = %v", err)
	}
}

func entitlementModules(
	t *testing.T,
	pool *pgxpool.Pool,
) (*billing.Service, *entitlement.Service, *postgresadapter.BillingStore, *postgresadapter.EntitlementStore) {
	t.Helper()
	billingStore, err := postgresadapter.NewBillingStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	entitlementStore, err := postgresadapter.NewEntitlementStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	billingService, err := billing.NewService(entitlementStore, billingStore)
	if err != nil {
		t.Fatal(err)
	}
	entitlementService, err := entitlement.NewService(
		billingService, entitlementStore, entitlementStore, entitlement.FukamuOfflineLeasePolicy(),
	)
	if err != nil {
		t.Fatal(err)
	}
	return billingService, entitlementService, billingStore, entitlementStore
}

func seedEntitlementOwner(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	accountSuffix int,
	vaultSuffix int,
	sessionSuffix int,
) identity.VaultContext {
	t.Helper()
	accountID := integrationAccountID(t, accountSuffix)
	vaultID := integrationVaultID(t, vaultSuffix)
	seedCryptoVault(t, ctx, pool, string(accountID), vaultID)
	return identity.VaultContext{
		AccountID: accountID, VaultID: vaultID, SessionID: integrationSessionID(t, sessionSuffix), SessionEpoch: 1,
	}
}

func startEntitlementTrial(
	t *testing.T,
	ctx context.Context,
	service *billing.Service,
	vaultContext identity.VaultContext,
	subscriptionSuffix int,
	checkoutSuffix int,
	eventID billing.ProviderEventID,
) *billing.SubscriptionFacts {
	t.Helper()
	subscriptionID, _ := billing.ParseSubscriptionID(integrationUUID(t, subscriptionSuffix))
	checkoutID, _ := billing.ParseCheckoutIntentID(integrationUUID(t, checkoutSuffix))
	created, err := service.BeginCheckout(ctx, vaultContext, billing.BeginCheckoutCommand{
		SubscriptionID: subscriptionID, CheckoutID: checkoutID, Provider: "stripe", CreatedAt: 1_000,
	})
	if err != nil || created.Kind != billing.ResultApplied {
		t.Fatalf("begin checkout = %#v, %v", created, err)
	}
	fact := integrationProviderFact(subscriptionID, billing.FactTrialStarted, eventID, 2_000)
	started, err := service.IngestVerifiedProviderFact(ctx, fact)
	if err != nil || started.Kind != billing.ResultApplied || started.Facts == nil {
		t.Fatalf("start trial = %#v, %v", started, err)
	}
	return started.Facts
}

func assertEntitlementSchema(t *testing.T, ctx context.Context, pool *pgxpool.Pool) {
	t.Helper()
	for _, table := range []string{"entitlement_projections", "entitlement_offline_leases"} {
		var exists bool
		if err := pool.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", "public."+table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatalf("missing entitlement table %s", table)
		}
	}
}

func pointerForIntegration(value int64) *int64 {
	return &value
}
