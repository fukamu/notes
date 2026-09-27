//go:build integration

package integration_test

import (
	"context"
	"errors"
	"reflect"
	"testing"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/fukamu/notes/backend/internal/quota"
)

func TestOperationsQuotaAuditIsOwnerScopedOrderedReadOnlyAndReplayablePostgres(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	vaultContext := seedEntitlementOwner(t, ctx, pool, 181, 281, 381)
	otherContext := seedEntitlementOwner(t, ctx, pool, 182, 282, 382)
	directory := quotaDirectory(t, pool)
	ledger := openQuotaLedger(t, ctx, directory, vaultContext, 1_000)
	otherLedger := openQuotaLedger(t, ctx, directory, otherContext, 1_000)
	limits := entitlement.PaidPersonalVaultLimits()
	commands := []quota.ReservationCommand{
		integrationQuotaCommand(t, 943, 993, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 1}, limits, 2_000, 5_000),
		integrationQuotaCommand(t, 942, 992, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 1}, limits, 2_001, 4_000),
		integrationQuotaCommand(t, 941, 991, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 1}, limits, 2_002, 4_000),
		integrationQuotaCommand(t, 944, 994, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 1}, limits, 2_003, 6_000),
		integrationQuotaCommand(t, 940, 990, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 1}, limits, 2_004, 3_000),
	}
	for _, command := range commands {
		if result, err := ledger.Reserve(ctx, command); err != nil || result.Kind != quota.ReservationApplied {
			t.Fatalf("reserve candidate = %#v, %v", result, err)
		}
	}
	if result, err := ledger.Finalize(ctx, quota.FinalizationCommand{
		ReservationID: commands[4].ReservationID, Fingerprint: commands[4].Fingerprint,
		Outcome: quota.FinalizationRelease, Limits: limits, FinalizedAt: 3_500,
	}); err != nil || result.Kind != quota.FinalizationReleased {
		t.Fatalf("finalize excluded candidate = %#v, %v", result, err)
	}
	otherCommand := integrationQuotaCommand(
		t, 939, 989, quota.Change{Kind: quota.ChangeCreate, NextPlaintextBytes: 1}, limits, 2_000, 3_500,
	)
	if result, err := otherLedger.Reserve(ctx, otherCommand); err != nil || result.Kind != quota.ReservationApplied {
		t.Fatalf("reserve other candidate = %#v, %v", result, err)
	}

	store, err := postgresadapter.NewQuotaAuditStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	service, err := operations.NewQuotaAuditService(store)
	if err != nil {
		t.Fatal(err)
	}
	query := operations.QuotaCandidateQuery{
		AccountID: vaultContext.AccountID, VaultID: vaultContext.VaultID, AsOfMillis: 5_000, Limit: 2,
	}
	first, err := service.ListCandidates(ctx, query)
	if err != nil || first.Kind != operations.QuotaAuditListed || len(first.Candidates) != 2 ||
		first.Candidates[0].ReservationID != commands[2].ReservationID ||
		first.Candidates[1].ReservationID != commands[1].ReservationID {
		t.Fatalf("ordered candidates = %#v, %v", first, err)
	}
	second, err := service.ListCandidates(ctx, query)
	if err != nil || !reflect.DeepEqual(first, second) {
		t.Fatalf("replayed audit = %#v, %v", second, err)
	}
	query.Limit = 100
	allDue, err := service.ListCandidates(ctx, query)
	if err != nil || len(allDue.Candidates) != 3 ||
		allDue.Candidates[2].ReservationID != commands[0].ReservationID {
		t.Fatalf("all due candidates = %#v, %v", allDue, err)
	}

	crossOwner := query
	crossOwner.VaultID = otherContext.VaultID
	refused, err := service.ListCandidates(ctx, crossOwner)
	if err != nil || refused.Kind != operations.QuotaAuditRefused ||
		refused.Reason != operations.QuotaAuditOwnerMismatch || len(refused.Candidates) != 0 {
		t.Fatalf("cross-owner result = %#v, %v", refused, err)
	}
	otherQuery := operations.QuotaCandidateQuery{
		AccountID: otherContext.AccountID, VaultID: otherContext.VaultID, AsOfMillis: 5_000, Limit: 100,
	}
	other, err := service.ListCandidates(ctx, otherQuery)
	if err != nil || len(other.Candidates) != 1 || other.Candidates[0].ReservationID != otherCommand.ReservationID {
		t.Fatalf("other owner candidates = %#v, %v", other, err)
	}

	var reserved int
	var released int
	if err := pool.QueryRow(ctx, `SELECT
		COUNT(*) FILTER (WHERE state = 'reserved'),
		COUNT(*) FILTER (WHERE state = 'released')
		FROM vault_quota_reservations WHERE account_id = $1 AND vault_id = $2`,
		string(vaultContext.AccountID), string(vaultContext.VaultID),
	).Scan(&reserved, &released); err != nil || reserved != 4 || released != 1 {
		t.Fatalf("audit mutated reservations: reserved = %d, released = %d, error = %v", reserved, released, err)
	}

	cancelled, cancel := context.WithCancel(ctx)
	cancel()
	if _, err := service.ListCandidates(cancelled, query); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled audit error = %v", err)
	}
}
