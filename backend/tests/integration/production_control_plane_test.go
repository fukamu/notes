//go:build integration

package integration_test

import (
	"context"
	"errors"
	"strings"
	"testing"

	postgresadapter "github.com/fukamu/notes/backend/internal/adapters/postgres"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/featureflag"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestProductionControlPlanePersistence(t *testing.T) {
	ctx, pool := openIdentitySignupDatabase(t)
	accountID := integrationAccountID(t, 171)
	vaultID := integrationVaultID(t, 271)
	seedProductionControlPlaneOwner(t, ctx, pool, accountID, vaultID)

	t.Run("OIDC transactions are durable and single use", func(t *testing.T) {
		store, err := postgresadapter.NewOidcTransactionStore(pool)
		if err != nil {
			t.Fatal(err)
		}
		transaction := productionOidcTransaction(t)
		if err := store.InsertPending(ctx, transaction); err != nil {
			t.Fatalf("InsertPending() error = %v", err)
		}
		if err := store.InsertPending(ctx, transaction); !errors.Is(err, postgresadapter.ErrOidcTransactionConflict) {
			t.Fatalf("duplicate InsertPending() error = %v", err)
		}
		consumed, err := store.ConsumeByState(ctx, transaction.State)
		if err != nil || consumed == nil || *consumed != transaction {
			t.Fatalf("ConsumeByState() = %#v, %v", consumed, err)
		}
		consumed, err = store.ConsumeByState(ctx, transaction.State)
		if err != nil || consumed != nil {
			t.Fatalf("second ConsumeByState() = %#v, %v", consumed, err)
		}
	})

	t.Run("nonce reservation is shared across store instances", func(t *testing.T) {
		first, err := postgresadapter.NewNonceReservationStore(pool)
		if err != nil {
			t.Fatal(err)
		}
		second, err := postgresadapter.NewNonceReservationStore(pool)
		if err != nil {
			t.Fatal(err)
		}
		version, _ := cryptocontent.ParseDEKVersion(1)
		reserved, err := first.ReserveNonce(ctx, vaultID, version, "AAAAAAAAAAAAAAAA")
		if err != nil || !reserved {
			t.Fatalf("first ReserveNonce() = %t, %v", reserved, err)
		}
		reserved, err = second.ReserveNonce(ctx, vaultID, version, "AAAAAAAAAAAAAAAA")
		if err != nil || reserved {
			t.Fatalf("duplicate ReserveNonce() = %t, %v", reserved, err)
		}
		missingVersion, _ := cryptocontent.ParseDEKVersion(2)
		if _, err := first.ReserveNonce(ctx, vaultID, missingVersion, "AQEBAQEBAQEBAQEB"); !errors.Is(err, postgresadapter.ErrInvalidNonceReservationOperation) {
			t.Fatalf("missing key ReserveNonce() error = %v", err)
		}
	})

	t.Run("limited grant is scoped expiring and revocable", func(t *testing.T) {
		store, err := postgresadapter.NewLimitedAccessStore(pool)
		if err != nil {
			t.Fatal(err)
		}
		grant := entitlement.LimitedAccessGrant{
			AccountID: accountID, VaultID: vaultID, GrantedAt: 1_000, ExpiresAt: 2_000,
			VaultLimits: entitlement.PaidPersonalVaultLimits(),
		}
		created, err := store.Create(ctx, grant)
		if err != nil || !created {
			t.Fatalf("Create() = %t, %v", created, err)
		}
		created, err = store.Create(ctx, grant)
		if err != nil || created {
			t.Fatalf("idempotent Create() = %t, %v", created, err)
		}
		conflict := grant
		conflict.ExpiresAt++
		if _, err := store.Create(ctx, conflict); !errors.Is(err, postgresadapter.ErrLimitedAccessConflict) {
			t.Fatalf("conflicting Create() error = %v", err)
		}
		service, err := entitlement.NewLimitedAccessService(store)
		if err != nil {
			t.Fatal(err)
		}
		vaultContext := productionVaultContext(t, accountID, vaultID)
		decision := service.AuthorizeCapability(ctx, vaultContext, entitlement.CapabilityNotesSync, 1_500)
		if decision.Kind != entitlement.DecisionAllowed || decision.Basis != entitlement.BasisLimited {
			t.Fatalf("authorized decision = %#v", decision)
		}
		limits := service.ReadLimits(ctx, vaultContext, 1_500)
		if limits.Kind != entitlement.LimitsAvailable || limits.Limits != grant.VaultLimits {
			t.Fatalf("limits = %#v", limits)
		}
		if expired := service.AuthorizeCapability(ctx, vaultContext, entitlement.CapabilityNotesSync, 2_000); expired.Reason != entitlement.DenialLimitedAccessExpired {
			t.Fatalf("expired decision = %#v", expired)
		}
		revoked, err := store.Revoke(ctx, accountID, vaultID, 1_600)
		if err != nil || !revoked {
			t.Fatalf("Revoke() = %t, %v", revoked, err)
		}
		if decision := service.AuthorizeCapability(ctx, vaultContext, entitlement.CapabilityNotesSync, 1_600); decision.Reason != entitlement.DenialLimitedAccessRevoked {
			t.Fatalf("revoked decision = %#v", decision)
		}
	})

	t.Run("billing checkout defaults off and supports account or global enablement", func(t *testing.T) {
		store, err := postgresadapter.NewFeatureFlagStore(pool)
		if err != nil {
			t.Fatal(err)
		}
		service, err := featureflag.NewService(store)
		if err != nil {
			t.Fatal(err)
		}
		assertFeatureFlag(t, ctx, service, featureflag.BillingCheckout, accountID, featureflag.DecisionDisabled)
		assertFeatureFlag(t, ctx, service, "unknown-flag", accountID, featureflag.DecisionDisabled)
		if err := store.SetAccountEnabled(ctx, featureflag.BillingCheckout, accountID, true, 1_000); err != nil {
			t.Fatal(err)
		}
		assertFeatureFlag(t, ctx, service, featureflag.BillingCheckout, accountID, featureflag.DecisionEnabled)
		otherAccount := integrationAccountID(t, 172)
		if _, err := pool.Exec(ctx, "INSERT INTO accounts(account_id, created_at) VALUES ($1, 1000)", string(otherAccount)); err != nil {
			t.Fatal(err)
		}
		assertFeatureFlag(t, ctx, service, featureflag.BillingCheckout, otherAccount, featureflag.DecisionDisabled)
		if err := store.SetAccountEnabled(ctx, featureflag.BillingCheckout, accountID, false, 1_001); err != nil {
			t.Fatal(err)
		}
		if err := store.Configure(ctx, featureflag.BillingCheckout, true, 1_002); err != nil {
			t.Fatal(err)
		}
		assertFeatureFlag(t, ctx, service, featureflag.BillingCheckout, accountID, featureflag.DecisionEnabled)
		assertFeatureFlag(t, ctx, service, featureflag.BillingCheckout, otherAccount, featureflag.DecisionEnabled)
	})

	t.Run("OIDC session binding enforces exact launch subject and owner scope", func(t *testing.T) {
		identityID := integrationIdentityID(t, 471)
		if _, err := pool.Exec(ctx, `INSERT INTO identities(
			identity_id, account_id, provider, issuer, subject, created_at
		) VALUES ($1, $2, 'google-oidc', 'https://accounts.google.com', 'google-subject', 1000)`,
			string(identityID), string(accountID)); err != nil {
			t.Fatal(err)
		}
		vaultContext := productionVaultContext(t, accountID, vaultID)
		created := identity.CreateActiveSession(identity.SessionInput{
			SessionID: vaultContext.SessionID, AccountID: accountID, VaultID: vaultID,
			SessionEpoch: vaultContext.SessionEpoch, IssuedAt: 1_000, ExpiresAt: 2_000,
		})
		token, err := identity.ParseSessionToken(strings.Repeat("T", 42) + "A")
		if err != nil || !created.Created {
			t.Fatalf("session fixture = %#v, %v", created, err)
		}
		sessions, err := postgresadapter.NewSessionStore(pool)
		if err != nil {
			t.Fatal(err)
		}
		if err := sessions.CreateOidcSession(ctx, created.Session, token, identityID); err != nil {
			t.Fatalf("CreateOidcSession() error = %v", err)
		}
		admission, err := postgresadapter.NewProductionAdmission(pool)
		if err != nil {
			t.Fatal(err)
		}
		denied, err := admission.AuthorizeVault(ctx, vaultContext)
		if err != nil || denied.CanAccess {
			t.Fatalf("unlisted admission = %#v, %v", denied, err)
		}
		if _, err := pool.Exec(ctx,
			"INSERT INTO launch_allowed_users(user_id, created_at) VALUES ('google-subject', 1000)",
		); err != nil {
			t.Fatal(err)
		}
		allowed, err := admission.AuthorizeVault(ctx, vaultContext)
		if err != nil || !allowed.CanAccess || !allowed.UserAllowed || allowed.PublicAccessEnabled {
			t.Fatalf("allowed admission = %#v, %v", allowed, err)
		}
		wrong := vaultContext
		wrong.SessionID = integrationSessionID(t, 372)
		if decision, err := admission.AuthorizeVault(ctx, wrong); err != nil || decision.CanAccess {
			t.Fatalf("wrong-session admission = %#v, %v", decision, err)
		}
	})
}

func seedProductionControlPlaneOwner(
	t *testing.T,
	ctx context.Context,
	pool *pgxpool.Pool,
	accountID identity.AccountID,
	vaultID identity.VaultID,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, "INSERT INTO accounts(account_id, created_at) VALUES ($1, 1000)", string(accountID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, "INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES ($1, $2, 1000)", string(vaultID), string(accountID)); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `INSERT INTO vault_dek_versions(
		vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
	) VALUES ($1, 1, 'projects/test/locations/test/keyRings/test/cryptoKeys/test/cryptoKeyVersions/1', 'd3JhcHBlZA', true, 1000)`, string(vaultID)); err != nil {
		t.Fatal(err)
	}
}

func productionOidcTransaction(t *testing.T) identity.PendingOidcTransaction {
	t.Helper()
	state, err := identity.ParseOidcState(strings.Repeat("C", 42) + "A")
	if err != nil {
		t.Fatal(err)
	}
	nonce, err := identity.ParseOidcNonce(strings.Repeat("D", 42) + "A")
	if err != nil {
		t.Fatal(err)
	}
	verifier, err := identity.ParsePkceCodeVerifier("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")
	if err != nil {
		t.Fatal(err)
	}
	redirect, err := identity.ParseOidcRedirectURI("https://notes.example/auth/google/callback")
	if err != nil {
		t.Fatal(err)
	}
	return identity.PendingOidcTransaction{
		State: state, Nonce: nonce, CodeVerifier: verifier, RedirectURI: redirect,
		Purpose:               identity.OidcPurpose{Kind: identity.OidcPurposeSignIn},
		CreatedAtEpochSeconds: 1_000, ExpiresAtEpochSeconds: 1_600,
	}
}

func productionVaultContext(
	t *testing.T,
	accountID identity.AccountID,
	vaultID identity.VaultID,
) identity.VaultContext {
	t.Helper()
	sessionID := integrationSessionID(t, 371)
	epoch, err := identity.ParseSessionEpoch(1)
	if err != nil {
		t.Fatal(err)
	}
	return identity.VaultContext{
		AccountID: accountID, VaultID: vaultID, SessionID: sessionID, SessionEpoch: epoch,
	}
}

func assertFeatureFlag(
	t *testing.T,
	ctx context.Context,
	service *featureflag.Service,
	name featureflag.Name,
	accountID identity.AccountID,
	want featureflag.DecisionKind,
) {
	t.Helper()
	decision, err := service.Evaluate(ctx, name, accountID)
	if err != nil || decision.Kind != want {
		t.Fatalf("Evaluate(%q) = %#v, %v; want %q", name, decision, err, want)
	}
}
