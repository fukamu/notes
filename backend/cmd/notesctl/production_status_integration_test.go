//go:build integration

package main

import (
	"context"
	"os"
	"testing"
	"time"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
)

func TestInspectProductionStatusAcrossReleaseStates(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required")
	}
	if err := postgresadapter.ValidateTestDatabaseURL(databaseURL); err != nil {
		t.Fatalf("unsafe test database target: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	pool, err := postgresadapter.OpenPool(ctx, databaseURL, 4)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	if _, err := pool.Exec(ctx, "DROP SCHEMA public CASCADE; CREATE SCHEMA public"); err != nil {
		t.Fatal(err)
	}
	status, err := inspectProductionStatus(ctx, databaseURL, 5_000)
	if err != nil || status.Outcome != operations.ProductionStatusBlocked ||
		len(status.Blockers) != 1 || status.Blockers[0] != operations.ProductionStatusSchemaMismatch {
		t.Fatalf("fresh status = %#v, %v", status, err)
	}
	if _, err := migrateDatabase(ctx, databaseURL); err != nil {
		t.Fatal(err)
	}
	status, err = inspectProductionStatus(ctx, databaseURL, 5_000)
	if err != nil || status.Outcome != operations.ProductionStatusRestrictedEmpty ||
		len(status.Blockers) != 0 {
		t.Fatalf("migrated status = %#v, %v", status, err)
	}
	store, err := postgresadapter.NewProductionAccessStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	command := productionStatusAccessCommand(t)
	if _, err := store.Provision(ctx, command); err != nil {
		t.Fatal(err)
	}
	status, err = inspectProductionStatus(ctx, databaseURL, 5_000)
	if err != nil || status.Outcome != operations.ProductionStatusRestrictedReady ||
		status.Facts.AllowedUsers != 1 || status.Facts.ActiveLimitedGrants != 1 ||
		status.Facts.WriteKeys != 1 || status.Facts.AccessInconsistencies != 0 ||
		status.Facts.CryptographicInconsistency != 0 {
		t.Fatalf("provisioned status = %#v, %v", status, err)
	}
	if _, err := store.Revoke(ctx, operations.ProductionAccessRevokeCommand{
		Identity: command.Identity, RevokedAtMilli: 20_000, SessionRevokedAtSeconds: 20,
	}); err != nil {
		t.Fatal(err)
	}
	status, err = inspectProductionStatus(ctx, databaseURL, 21_000)
	if err != nil || status.Outcome != operations.ProductionStatusRestrictedEmpty ||
		status.Facts.Accounts != 1 || status.Facts.Vaults != 1 || status.Facts.WriteKeys != 1 ||
		status.Facts.AllowedUsers != 0 || status.Facts.ActiveLimitedGrants != 0 {
		t.Fatalf("revoked status = %#v, %v", status, err)
	}
	if _, err := pool.Exec(
		ctx, "INSERT INTO launch_allowed_users(user_id, created_at) VALUES ('unmapped-subject', 22000)",
	); err != nil {
		t.Fatal(err)
	}
	status, err = inspectProductionStatus(ctx, databaseURL, 22_000)
	if err != nil || status.Outcome != operations.ProductionStatusBlocked ||
		status.Facts.AccessInconsistencies != 1 ||
		len(status.Blockers) != 1 || status.Blockers[0] != operations.ProductionStatusAccessInconsistent {
		t.Fatalf("inconsistent status = %#v, %v", status, err)
	}
}

func productionStatusAccessCommand(t *testing.T) operations.ProductionAccessProvisionCommand {
	t.Helper()
	accountID, err := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000951")
	if err != nil {
		t.Fatal(err)
	}
	vaultID, err := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000952")
	if err != nil {
		t.Fatal(err)
	}
	identityID, err := identity.ParseIdentityID("01991f20-61d2-7000-8000-000000000953")
	if err != nil {
		t.Fatal(err)
	}
	issuer, err := identity.ParseOidcIssuer("https://accounts.google.com")
	if err != nil {
		t.Fatal(err)
	}
	subject, err := identity.ParseOidcSubject("1000000000000000951")
	if err != nil {
		t.Fatal(err)
	}
	return operations.ProductionAccessProvisionCommand{
		Identity:   operations.ProductionAccessIdentity{Issuer: issuer, Subject: subject},
		IdentityID: identityID, AccountID: accountID, VaultID: vaultID, CreatedAt: 1_000,
		Grant: entitlement.LimitedAccessGrant{
			AccountID: accountID, VaultID: vaultID, GrantedAt: 1_000, ExpiresAt: 10_000,
			VaultLimits: entitlement.PaidPersonalVaultLimits(),
		},
		WriteKey: cryptocontent.VaultDEKMetadata{
			VaultID: vaultID, DEKVersion: 1,
			KEKReference: "projects/test/locations/asia-southeast1/keyRings/notes/cryptoKeys/content/cryptoKeyVersions/1",
			WrappedDEK:   "d3JhcHBlZC1kZWs", CreatedAtMilli: 1_000,
		},
	}
}
