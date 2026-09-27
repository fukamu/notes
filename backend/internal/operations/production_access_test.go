package operations_test

import (
	"testing"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
)

func TestProductionAccessCommandsRequireExactRestrictedScope(t *testing.T) {
	t.Parallel()
	accountID, _ := identity.ParseAccountID("01991f20-61d2-7000-8000-000000000901")
	vaultID, _ := identity.ParseVaultID("01991f20-61d2-7000-8000-000000000902")
	identityID, _ := identity.ParseIdentityID("01991f20-61d2-7000-8000-000000000903")
	issuer, _ := identity.ParseOidcIssuer("https://accounts.google.com")
	subject, _ := identity.ParseOidcSubject("1000000000000000901")
	command := operations.ProductionAccessProvisionCommand{
		Identity:   operations.ProductionAccessIdentity{Issuer: issuer, Subject: subject},
		IdentityID: identityID, AccountID: accountID, VaultID: vaultID, CreatedAt: 1_000,
		Grant: entitlement.LimitedAccessGrant{
			AccountID: accountID, VaultID: vaultID, GrantedAt: 1_000, ExpiresAt: 2_000,
			VaultLimits: entitlement.PaidPersonalVaultLimits(),
		},
		WriteKey: cryptocontent.VaultDEKMetadata{
			VaultID: vaultID, DEKVersion: 1,
			KEKReference: "projects/fukamu-notes/locations/asia-southeast1/keyRings/notes/cryptoKeys/content/cryptoKeyVersions/1",
			WrappedDEK:   "d3JhcHBlZC1kZWs", CreatedAtMilli: 1_000,
		},
	}
	if err := operations.ValidateProductionAccessProvisionCommand(command); err != nil {
		t.Fatalf("valid command rejected: %v", err)
	}
	mismatch := command
	mismatch.Grant.VaultID, _ = identity.ParseVaultID("01991f20-61d2-7000-8000-000000000904")
	if err := operations.ValidateProductionAccessProvisionCommand(mismatch); err == nil {
		t.Fatal("cross-vault grant accepted")
	}
	invalidKey := command
	invalidKey.WriteKey.DEKVersion = 2
	if err := operations.ValidateProductionAccessProvisionCommand(invalidKey); err == nil {
		t.Fatal("non-initial write key accepted")
	}
	if err := operations.ValidateProductionAccessRevokeCommand(operations.ProductionAccessRevokeCommand{
		Identity: command.Identity, RevokedAtMilli: 2_000, SessionRevokedAtSeconds: 2,
	}); err != nil {
		t.Fatalf("valid revocation rejected: %v", err)
	}
}
