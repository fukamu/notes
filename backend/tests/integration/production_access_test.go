//go:build integration

package integration_test

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
	"github.com/fukamu/notes/backend/migrations"
)

func TestProductionAccessProvisionAndRevoke(t *testing.T) {
	databaseURL := os.Getenv("NOTES_TEST_DATABASE_URL")
	if databaseURL == "" {
		t.Fatal("NOTES_TEST_DATABASE_URL is required for integration tests")
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
	database, err := postgresadapter.OpenSQL(ctx, databaseURL)
	if err != nil {
		t.Fatal(err)
	}
	defer database.Close()
	migrator, err := postgresadapter.NewMigrator(database, migrations.Files)
	if err != nil {
		t.Fatal(err)
	}
	if err := migrator.Up(ctx); err != nil {
		t.Fatal(err)
	}
	store, err := postgresadapter.NewProductionAccessStore(pool)
	if err != nil {
		t.Fatal(err)
	}
	command := productionAccessCommand(t, 901, 10_000)
	if _, err := pool.Exec(ctx, "UPDATE launch_config SET public_access_enabled = true WHERE singleton = 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Provision(ctx, command); err != postgresadapter.ErrProductionAccessConflict {
		t.Fatalf("public launch provisioning error = %v", err)
	}
	if _, err := pool.Exec(ctx, "UPDATE launch_config SET public_access_enabled = false WHERE singleton = 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "UPDATE feature_flags SET globally_enabled = true WHERE flag_name = 'billing-checkout'"); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Provision(ctx, command); err != postgresadapter.ErrProductionAccessConflict {
		t.Fatalf("enabled checkout provisioning error = %v", err)
	}
	if _, err := pool.Exec(ctx, "UPDATE feature_flags SET globally_enabled = false WHERE flag_name = 'billing-checkout'"); err != nil {
		t.Fatal(err)
	}
	created, err := store.Provision(ctx, command)
	if err != nil || created.Kind != operations.ProductionAccessCreated ||
		created.AccountID != command.AccountID || created.VaultID != command.VaultID {
		t.Fatalf("Provision() = %#v, %v", created, err)
	}
	preflight, err := store.FindProvisioned(
		ctx, command.Identity, command.Grant.ExpiresAt,
		command.Grant.VaultLimits, command.WriteKey.KEKReference,
	)
	if err != nil || preflight == nil || preflight.Kind != operations.ProductionAccessReplayed ||
		preflight.AccountID != command.AccountID || preflight.VaultID != command.VaultID {
		t.Fatalf("FindProvisioned() = %#v, %v", preflight, err)
	}
	replayCandidate := productionAccessCommand(t, 911, 10_000)
	replayCandidate.Identity = command.Identity
	replay, err := store.Provision(ctx, replayCandidate)
	if err != nil || replay.Kind != operations.ProductionAccessReplayed ||
		replay.AccountID != command.AccountID || replay.VaultID != command.VaultID ||
		replay.IdentityID != command.IdentityID {
		t.Fatalf("replayed Provision() = %#v, %v", replay, err)
	}
	conflict := replayCandidate
	conflict.Grant.ExpiresAt++
	if _, err := store.Provision(ctx, conflict); err != postgresadapter.ErrProductionAccessConflict {
		t.Fatalf("changed grant error = %v", err)
	}
	if _, err := pool.Exec(
		ctx,
		`INSERT INTO sessions(
		   session_id, account_id, vault_id, token_hash, session_epoch,
		   issued_at, expires_at, revoked_at, revocation_reason
		 ) VALUES ($1, $2, $3, 'production-access-test-hash', 1, 9, 99, NULL, NULL)`,
		"01991f20-61d2-7000-8000-000000000999", string(command.AccountID), string(command.VaultID),
	); err != nil {
		t.Fatal(err)
	}
	revokeCommand := operations.ProductionAccessRevokeCommand{
		Identity: command.Identity, RevokedAtMilli: 20_000, SessionRevokedAtSeconds: 20,
	}
	revoked, err := store.Revoke(ctx, revokeCommand)
	if err != nil || revoked.Kind != operations.ProductionAccessRevoked || revoked.SessionsRevoked != 1 {
		t.Fatalf("Revoke() = %#v, %v", revoked, err)
	}
	replayedRevoke, err := store.Revoke(ctx, revokeCommand)
	if err != nil || replayedRevoke.Kind != operations.ProductionAccessAlreadyRevoked ||
		replayedRevoke.SessionsRevoked != 0 {
		t.Fatalf("replayed Revoke() = %#v, %v", replayedRevoke, err)
	}
	var allowed bool
	var revokedAt int64
	var sessionReason string
	if err := pool.QueryRow(
		ctx, "SELECT EXISTS (SELECT 1 FROM launch_allowed_users WHERE user_id = $1)",
		string(command.Identity.Subject),
	).Scan(&allowed); err != nil || allowed {
		t.Fatalf("allowlist remains: %t, %v", allowed, err)
	}
	if err := pool.QueryRow(
		ctx, "SELECT revoked_at FROM limited_access_grants WHERE account_id = $1 AND vault_id = $2",
		string(command.AccountID), string(command.VaultID),
	).Scan(&revokedAt); err != nil || revokedAt != 20_000 {
		t.Fatalf("grant revoked_at = %d, %v", revokedAt, err)
	}
	if err := pool.QueryRow(
		ctx, "SELECT revocation_reason FROM sessions WHERE account_id = $1 AND vault_id = $2",
		string(command.AccountID), string(command.VaultID),
	).Scan(&sessionReason); err != nil || sessionReason != "security" {
		t.Fatalf("session reason = %q, %v", sessionReason, err)
	}
	var retained int
	if err := pool.QueryRow(
		ctx,
		`SELECT count(*) FROM accounts account
		   JOIN personal_vaults vault ON vault.account_id = account.account_id
		   JOIN vault_dek_versions key ON key.vault_id = vault.vault_id
		  WHERE account.account_id = $1 AND vault.vault_id = $2`,
		string(command.AccountID), string(command.VaultID),
	).Scan(&retained); err != nil || retained != 1 {
		t.Fatalf("retained scope = %d, %v", retained, err)
	}
}

func productionAccessCommand(
	t *testing.T,
	suffix int,
	expiresAt int64,
) operations.ProductionAccessProvisionCommand {
	t.Helper()
	accountID, _ := identity.ParseAccountID(integrationUUID(t, suffix))
	vaultID, _ := identity.ParseVaultID(integrationUUID(t, suffix+1))
	identityID, _ := identity.ParseIdentityID(integrationUUID(t, suffix+2))
	issuer, _ := identity.ParseOidcIssuer("https://accounts.google.com")
	subject, _ := identity.ParseOidcSubject("1000000000000000901")
	return operations.ProductionAccessProvisionCommand{
		Identity:   operations.ProductionAccessIdentity{Issuer: issuer, Subject: subject},
		IdentityID: identityID, AccountID: accountID, VaultID: vaultID, CreatedAt: 1_000,
		Grant: entitlement.LimitedAccessGrant{
			AccountID: accountID, VaultID: vaultID, GrantedAt: 1_000, ExpiresAt: expiresAt,
			VaultLimits: entitlement.PaidPersonalVaultLimits(),
		},
		WriteKey: cryptocontent.VaultDEKMetadata{
			VaultID: vaultID, DEKVersion: 1,
			KEKReference: "projects/fukamu-notes/locations/asia-southeast1/keyRings/notes/cryptoKeys/content/cryptoKeyVersions/1",
			WrappedDEK:   "d3JhcHBlZC1kZWs", CreatedAtMilli: 1_000,
		},
	}
}
