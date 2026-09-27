package entitlement_test

import (
	"context"
	"errors"
	"testing"

	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
)

type limitedReader struct {
	grant *entitlement.LimitedAccessGrant
	err   error
}

func (reader limitedReader) FindLimitedAccessGrant(
	context.Context,
	identity.AccountID,
	identity.VaultID,
) (*entitlement.LimitedAccessGrant, error) {
	return reader.grant, reader.err
}

func TestLimitedAccessAuthorizationEnforcesScopeExpiryAndRevocation(t *testing.T) {
	t.Parallel()
	grant, vaultContext := limitedFixture(t)
	allowed := entitlement.AuthorizeLimitedAccess(
		&grant, vaultContext, entitlement.CapabilityNotesSync, 1_500,
	)
	if allowed.Kind != entitlement.DecisionAllowed || allowed.Basis != entitlement.BasisLimited ||
		allowed.ValidUntil == nil || *allowed.ValidUntil != grant.ExpiresAt {
		t.Fatalf("allowed = %#v", allowed)
	}

	other := vaultContext
	other.VaultID, _ = identity.ParseVaultID("01991f20-61d2-7000-8000-000000000299")
	if decision := entitlement.AuthorizeLimitedAccess(
		&grant, other, entitlement.CapabilityNotesSync, 1_500,
	); decision.Reason != entitlement.DenialOwnerMismatch {
		t.Fatalf("owner mismatch = %#v", decision)
	}
	if decision := entitlement.AuthorizeLimitedAccess(
		&grant, vaultContext, entitlement.CapabilityNotesSync, grant.ExpiresAt,
	); decision.Reason != entitlement.DenialLimitedAccessExpired {
		t.Fatalf("expired = %#v", decision)
	}
	revokedAt := int64(1_600)
	grant.RevokedAt = &revokedAt
	if decision := entitlement.AuthorizeLimitedAccess(
		&grant, vaultContext, entitlement.CapabilityNotesSync, revokedAt,
	); decision.Reason != entitlement.DenialLimitedAccessRevoked {
		t.Fatalf("revoked = %#v", decision)
	}
	if decision := entitlement.AuthorizeLimitedAccess(
		nil, vaultContext, entitlement.CapabilityNotesSync, 1_500,
	); decision.Reason != entitlement.DenialLimitedAccessRequired {
		t.Fatalf("missing = %#v", decision)
	}
	if decision := entitlement.AuthorizeLimitedAccess(
		&grant, vaultContext, entitlement.CapabilityAccountDelete, 1_500,
	); decision.Reason != entitlement.DenialInvalidInput {
		t.Fatalf("non-content = %#v", decision)
	}
}

func TestLimitedAccessServiceReturnsStoredLimitsAndFailsClosed(t *testing.T) {
	t.Parallel()
	grant, vaultContext := limitedFixture(t)
	service, err := entitlement.NewLimitedAccessService(limitedReader{grant: &grant})
	if err != nil {
		t.Fatal(err)
	}
	limits := service.ReadLimits(context.Background(), vaultContext, 1_500)
	if limits.Kind != entitlement.LimitsAvailable || limits.Limits != grant.VaultLimits ||
		limits.ValidUntil != grant.ExpiresAt {
		t.Fatalf("limits = %#v", limits)
	}
	wantErr := errors.New("database unavailable")
	failing, _ := entitlement.NewLimitedAccessService(limitedReader{err: wantErr})
	decision := failing.AuthorizeCapability(
		context.Background(), vaultContext, entitlement.CapabilityNotesSync, 1_500,
	)
	if decision.Kind != entitlement.DecisionDenied || decision.Reason != entitlement.DenialEntitlementUnavailable {
		t.Fatalf("failure = %#v", decision)
	}
}

func limitedFixture(t *testing.T) (entitlement.LimitedAccessGrant, identity.VaultContext) {
	t.Helper()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000101")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000201")
	sessionID, _ := identity.ParseSessionID("01991f20-61d2-7000-8000-000000000301")
	epoch, _ := identity.ParseSessionEpoch(1)
	return entitlement.LimitedAccessGrant{
		AccountID: accountID, VaultID: vaultID, GrantedAt: 1_000, ExpiresAt: 2_000,
		VaultLimits: entitlement.PaidPersonalVaultLimits(),
	}, identity.VaultContext{
		AccountID: accountID, VaultID: vaultID, SessionID: sessionID, SessionEpoch: epoch,
	}
}
