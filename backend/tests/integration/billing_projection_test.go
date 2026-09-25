//go:build integration

package integration_test

import (
	"context"
	"sync"
	"testing"

	"github.com/fukamu/notes/backend/internal/accountdeletion"
	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestBillingProjectionAtomicityAndReplayPostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	accountA, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	accountB, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000102")
	vaultA, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	vaultB, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000202")
	seedCryptoVault(t, ctx, pool, string(accountA), vaultA)
	seedCryptoVault(t, ctx, pool, string(accountB), vaultB)
	store, err := postgresadapter.NewBillingStore(pool)
	if err != nil {
		t.Fatal(err)
	}

	recordA, intentA := integrationBillingCheckout(t, accountA, vaultA, 701, 702)
	created, err := store.CreateCheckout(ctx, recordA, intentA)
	if err != nil || created.Kind != billing.CheckoutCreated {
		t.Fatalf("create checkout = %#v, %v", created, err)
	}
	replayed, err := store.CreateCheckout(ctx, recordA, intentA)
	if err != nil || replayed.Kind != billing.CheckoutExisting || replayed.Record == nil || replayed.Intent == nil {
		t.Fatalf("replay checkout = %#v, %v", replayed, err)
	}
	conflictingRecord, conflictingIntent := integrationBillingCheckout(t, accountA, vaultA, 703, 704)
	conflict, err := store.CreateCheckout(ctx, conflictingRecord, conflictingIntent)
	if err != nil || conflict.Kind != billing.CheckoutExisting || conflict.Record == nil || conflict.Intent != nil {
		t.Fatalf("owner conflict = %#v, %v", conflict, err)
	}

	openedAt := int64(1_100)
	openedIntent := intentA
	openedIntent.Status = billing.CheckoutIntentOpened
	openedIntent.ProviderCheckoutReference = "cs_notes_a"
	openedIntent.OpenedAt = &openedAt
	if result, err := store.OpenCheckout(ctx, billing.OwnerScope{AccountID: accountA, VaultID: vaultA}, openedIntent); err != nil || result != billing.CommitApplied {
		t.Fatalf("open checkout = %s, %v", result, err)
	}
	if result, err := store.OpenCheckout(ctx, billing.OwnerScope{AccountID: accountA, VaultID: vaultA}, openedIntent); err != nil || result != billing.CommitReplayed {
		t.Fatalf("replay opened checkout = %s, %v", result, err)
	}
	wrongReference := openedIntent
	wrongReference.ProviderCheckoutReference = "cs_other"
	if result, err := store.OpenCheckout(ctx, billing.OwnerScope{AccountID: accountA, VaultID: vaultA}, wrongReference); err != nil || result != billing.CommitConflict {
		t.Fatalf("opened checkout mismatch = %s, %v", result, err)
	}
	if result, err := store.OpenCheckout(ctx, billing.OwnerScope{AccountID: accountB, VaultID: vaultB}, openedIntent); err != nil || result != billing.CommitConflict {
		t.Fatalf("cross-owner checkout = %s, %v", result, err)
	}

	trialFact := integrationProviderFact(recordA.SubscriptionID, billing.FactTrialStarted, "evt_trial", 2_000)
	trialPlan := billing.PlanVerifiedProviderFact(recordA, trialFact)
	if trialPlan.Kind != billing.ProviderFactApply {
		t.Fatalf("trial plan = %#v", trialPlan)
	}
	trialReceipt := integrationReceipt(trialFact, trialPlan.Record, billing.ReceiptApplied)
	if result, err := store.CommitProviderFact(ctx, recordA, trialPlan.Record, trialReceipt); err != nil || result != billing.CommitApplied {
		t.Fatalf("trial commit = %s, %v", result, err)
	}
	if result, err := store.CommitProviderFact(ctx, recordA, trialPlan.Record, trialReceipt); err != nil || result != billing.CommitDuplicate {
		t.Fatalf("lost response retry = %s, %v", result, err)
	}

	current, err := store.FindByID(ctx, recordA.SubscriptionID)
	if err != nil || current == nil || current.Version != 2 || current.Lifecycle.Kind != billing.LifecycleTrialing {
		t.Fatalf("trial state = %#v, %v", current, err)
	}
	assertAccountDeletionBillingEffect(t, ctx, store, *current)
	assertConcurrentBillingCAS(t, ctx, store, *current)
	current, err = store.FindByID(ctx, recordA.SubscriptionID)
	if err != nil || current == nil || current.Version != 3 {
		t.Fatalf("post-CAS state = %#v, %v", current, err)
	}
	var receipts int
	if err := pool.QueryRow(ctx, "SELECT COUNT(*) FROM billing_provider_event_receipts WHERE subscription_id = $1", string(recordA.SubscriptionID)).Scan(&receipts); err != nil {
		t.Fatal(err)
	}
	if receipts != 2 {
		t.Fatalf("provider receipts = %d, want 2", receipts)
	}

	firstSnapshot := integrationSnapshot(recordA.SubscriptionID, "snapshot-a", 8_000, false)
	firstPlan := billing.PlanReconciliationSnapshot(*current, firstSnapshot)
	if firstPlan.Kind != billing.ProviderFactApply {
		t.Fatalf("first reconciliation plan = %#v", firstPlan)
	}
	firstCheckpoint := integrationCheckpoint(firstSnapshot, firstPlan.Record)
	if result, err := store.CommitReconciliation(ctx, *current, firstPlan.Record, firstCheckpoint); err != nil || result != billing.CommitApplied {
		t.Fatalf("first reconciliation = %s, %v", result, err)
	}
	if result, err := store.CommitReconciliation(ctx, *current, firstPlan.Record, firstCheckpoint); err != nil || result != billing.CommitDuplicate {
		t.Fatalf("reconciliation lost response = %s, %v", result, err)
	}

	current, _ = store.FindByID(ctx, recordA.SubscriptionID)
	secondSnapshot := integrationSnapshot(recordA.SubscriptionID, "snapshot-b", 8_000, true)
	secondPlan := billing.PlanReconciliationSnapshot(*current, secondSnapshot)
	if secondPlan.Kind != billing.ProviderFactApply || secondPlan.Record.Lifecycle.Kind != billing.LifecycleDelinquent {
		t.Fatalf("same-millisecond reconciliation plan = %#v", secondPlan)
	}
	if result, err := store.CommitReconciliation(ctx, *current, secondPlan.Record, integrationCheckpoint(secondSnapshot, secondPlan.Record)); err != nil || result != billing.CommitApplied {
		t.Fatalf("same-millisecond reconciliation = %s, %v", result, err)
	}

	recordB, intentB := integrationBillingCheckout(t, accountB, vaultB, 711, 712)
	if result, err := store.CreateCheckout(ctx, recordB, intentB); err != nil || result.Kind != billing.CheckoutCreated {
		t.Fatalf("second owner checkout = %#v, %v", result, err)
	}
	collision := trialReceipt
	collision.SubscriptionID = recordB.SubscriptionID
	collision.AppliedVersion = recordB.Version
	collision.Outcome = billing.ReceiptIgnored
	if result, err := store.RecordIgnoredProviderFact(ctx, collision); err != nil || result != billing.CommitConflict {
		t.Fatalf("cross-subscription event collision = %s, %v", result, err)
	}
	storedB, _ := store.FindByID(ctx, recordB.SubscriptionID)
	if storedB == nil || storedB.Version != 1 || storedB.Lifecycle.Kind != billing.LifecycleCheckoutPending {
		t.Fatalf("event collision mutated second subscription = %#v", storedB)
	}

	assertBillingProjectionSchema(t, ctx, pool)
	if pool.Stat().AcquiredConns() != 0 {
		t.Fatalf("database connections still acquired: %d", pool.Stat().AcquiredConns())
	}
}

func assertAccountDeletionBillingEffect(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.BillingStore,
	current billing.SubscriptionRecord,
) {
	t.Helper()
	provider := &integrationCancellationProvider{}
	cancellation, err := billing.NewCancellationService(store, provider)
	if err != nil {
		t.Fatal(err)
	}
	effect, err := accountdeletion.NewBillingCancellationEffect(cancellation)
	if err != nil {
		t.Fatal(err)
	}
	operationID, err := accountdeletion.ParseOperationID("01991f20-61d2-7000-8000-000000002701")
	if err != nil {
		t.Fatal(err)
	}
	result, err := effect.CancelSubscriptionImmediately(ctx, accountdeletion.StepEffectInput{
		Scope:       accountdeletion.Scope{AccountID: current.AccountID, VaultID: current.VaultID},
		OperationID: operationID, Step: accountdeletion.StepCancelSubscription,
		Attempt: 1, RequestedAt: 2_100, ExecutedAt: 2_200,
	})
	if err != nil || result.Kind != accountdeletion.EffectSucceeded || len(provider.commands) != 1 {
		t.Fatalf("deletion cancellation = %#v commands=%#v err=%v", result, provider.commands, err)
	}
	command := provider.commands[0]
	if command.ProviderSubscriptionReference != current.ProviderSubscriptionReference ||
		string(command.IdempotencyKey) != string(operationID) || command.RequestedAt != 2_100 {
		t.Fatalf("provider command = %#v", command)
	}
	after, err := store.FindByID(ctx, current.SubscriptionID)
	if err != nil || after == nil || after.Version != current.Version || after.Lifecycle != current.Lifecycle {
		t.Fatalf("projection changed = %#v, %v", after, err)
	}
}

type integrationCancellationProvider struct {
	commands []billing.ProviderCancellationCommand
}

func (provider *integrationCancellationProvider) CancelSubscription(
	_ context.Context,
	command billing.ProviderCancellationCommand,
) (billing.ProviderCancellationObservation, error) {
	provider.commands = append(provider.commands, command)
	return billing.ProviderCancellationObservation{
		Kind: billing.ProviderCancellationCancelled, Provider: command.Provider,
		ProviderSubscriptionReference: command.ProviderSubscriptionReference,
		IdempotencyKey:                command.IdempotencyKey, ObservedAt: command.RequestedAt,
	}, nil
}

func assertConcurrentBillingCAS(
	t *testing.T,
	ctx context.Context,
	store *postgresadapter.BillingStore,
	current billing.SubscriptionRecord,
) {
	t.Helper()
	facts := []billing.VerifiedProviderFact{
		integrationProviderFact(current.SubscriptionID, billing.FactPaymentMethodUpdated, "evt_card", 3_000),
		integrationProviderFact(current.SubscriptionID, billing.FactCancellationScheduled, "evt_cancel", 4_000),
	}
	type outcome struct {
		kind billing.CommitKind
		err  error
	}
	outcomes := make(chan outcome, len(facts))
	var start sync.WaitGroup
	start.Add(1)
	for _, fact := range facts {
		fact := fact
		go func() {
			start.Wait()
			plan := billing.PlanVerifiedProviderFact(current, fact)
			if plan.Kind != billing.ProviderFactApply {
				outcomes <- outcome{err: postgresadapter.ErrInvalidBillingOperation}
				return
			}
			kind, err := store.CommitProviderFact(ctx, current, plan.Record, integrationReceipt(fact, plan.Record, billing.ReceiptApplied))
			outcomes <- outcome{kind: kind, err: err}
		}()
	}
	start.Done()
	applied, conflicts := 0, 0
	for range facts {
		result := <-outcomes
		if result.err != nil {
			t.Fatal(result.err)
		}
		switch result.kind {
		case billing.CommitApplied:
			applied++
		case billing.CommitConflict:
			conflicts++
		default:
			t.Fatalf("concurrent commit = %s", result.kind)
		}
	}
	if applied != 1 || conflicts != 1 {
		t.Fatalf("concurrent outcomes applied=%d conflicts=%d", applied, conflicts)
	}
}

func integrationBillingCheckout(
	t *testing.T,
	accountID identity.AccountID,
	vaultID identity.VaultID,
	subscriptionSuffix int,
	checkoutSuffix int,
) (billing.SubscriptionRecord, billing.CheckoutIntentRecord) {
	t.Helper()
	subscriptionID, err := billing.ParseSubscriptionID(integrationUUID(t, subscriptionSuffix))
	if err != nil {
		t.Fatal(err)
	}
	checkoutID, err := billing.ParseCheckoutIntentID(integrationUUID(t, checkoutSuffix))
	if err != nil {
		t.Fatal(err)
	}
	command := billing.BeginCheckoutCommand{
		SubscriptionID: subscriptionID, CheckoutID: checkoutID, Provider: "stripe", CreatedAt: 1_000,
	}
	plan := billing.PlanCheckoutCreation(billing.OwnerScope{AccountID: accountID, VaultID: vaultID}, command)
	if plan.Kind != billing.CheckoutPlanCreate {
		t.Fatalf("checkout plan = %#v", plan)
	}
	return plan.Record, billing.CheckoutIntentRecord{
		CheckoutIntentID: checkoutID, SubscriptionID: subscriptionID, Provider: "stripe",
		Status: billing.CheckoutIntentCreated, CreatedAt: 1_000,
	}
}

func integrationProviderFact(
	subscriptionID billing.SubscriptionID,
	kind billing.FactKind,
	eventID billing.ProviderEventID,
	occurredAt int64,
) billing.VerifiedProviderFact {
	fact := billing.VerifiedProviderFact{
		Kind: kind, SubscriptionID: subscriptionID, Provider: "stripe", EventID: eventID,
		ProviderCustomerReference: "cus_notes", ProviderSubscriptionReference: "sub_notes",
		OccurredAt: occurredAt, RecordedAt: occurredAt + 100,
	}
	switch kind {
	case billing.FactTrialStarted:
		fact.TrialStartedAt = occurredAt
		fact.TrialEndsAt = occurredAt + billing.TrialDurationMilliseconds
	case billing.FactInvoicePaid:
		fact.InvoiceReference = "in_paid"
		fact.PaidPeriodStartedAt = occurredAt
		fact.PaidPeriodEndsAt = occurredAt + 10_000
	case billing.FactInvoicePaymentFailed, billing.FactInvoicePaymentActionRequired:
		fact.InvoiceReference = "in_failed"
	case billing.FactCancellationScheduled:
		fact.CancelAt = occurredAt + 10_000
	case billing.FactSubscriptionCancelled:
		fact.CancelledAt = occurredAt
	}
	return fact
}

func integrationReceipt(
	fact billing.VerifiedProviderFact,
	record billing.SubscriptionRecord,
	outcome billing.ReceiptOutcome,
) billing.ProviderEventReceipt {
	return billing.ProviderEventReceipt{
		Provider: fact.Provider, EventID: fact.EventID, SubscriptionID: fact.SubscriptionID,
		FactKind: fact.Kind, Outcome: outcome, OccurredAt: fact.OccurredAt,
		AppliedVersion: record.Version, RecordedAt: fact.RecordedAt,
	}
}

func integrationSnapshot(
	subscriptionID billing.SubscriptionID,
	snapshotID billing.ReconciliationSnapshotID,
	observedAt int64,
	delinquent bool,
) billing.ReconciliationSnapshot {
	snapshot := billing.ReconciliationSnapshot{
		SnapshotID: snapshotID, SubscriptionID: subscriptionID, Provider: "stripe",
		ProviderCustomerReference: "cus_notes", ProviderSubscriptionReference: "sub_notes",
		ObservedAt: observedAt, RecordedAt: observedAt + 100, PaymentMethodReady: true,
		PaymentMethodUpdatedAt: observedAt, CancellationUpdatedAt: observedAt,
	}
	if delinquent {
		snapshot.Delinquency = &billing.ReconciliationDelinquency{
			Reason: billing.DelinquencyPaymentActionRequired, InvoiceReference: "in_same_time", OccurredAt: observedAt,
		}
	} else {
		snapshot.LatestPaidInvoice = &billing.ReconciliationPaidInvoice{
			InvoiceReference: "in_snapshot", PaidAt: observedAt,
			PeriodStartedAt: observedAt, PeriodEndsAt: observedAt + 10_000,
		}
	}
	return snapshot
}

func integrationCheckpoint(
	snapshot billing.ReconciliationSnapshot,
	record billing.SubscriptionRecord,
) billing.ReconciliationCheckpoint {
	return billing.ReconciliationCheckpoint{
		Provider: snapshot.Provider, SnapshotID: snapshot.SnapshotID, SubscriptionID: snapshot.SubscriptionID,
		ObservedAt: snapshot.ObservedAt, AppliedVersion: record.Version, RecordedAt: snapshot.RecordedAt,
	}
}

func assertBillingProjectionSchema(t *testing.T, ctx context.Context, query *pgxpool.Pool) {
	t.Helper()
	for _, table := range []string{
		"billing_subscriptions", "billing_checkout_intents",
		"billing_provider_event_receipts", "billing_reconciliation_checkpoints",
	} {
		var exists bool
		if err := query.QueryRow(ctx, "SELECT to_regclass($1) IS NOT NULL", "public."+table).Scan(&exists); err != nil {
			t.Fatal(err)
		}
		if !exists {
			t.Fatalf("missing billing table %s", table)
		}
	}
}
