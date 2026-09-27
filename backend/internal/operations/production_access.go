package operations

import (
	"errors"

	"github.com/fukamu/notes/backend/internal/access"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
)

var ErrProductionAccess = errors.New("production access operation refused")

type ProductionAccessIdentity struct {
	Issuer  identity.OidcIssuer
	Subject identity.OidcSubject
}

func ValidProductionAccessIdentity(value ProductionAccessIdentity) bool {
	issuer, issuerErr := identity.ParseOidcIssuer(string(value.Issuer))
	subject, subjectErr := identity.ParseOidcSubject(string(value.Subject))
	launchSubject, launchErr := access.ParseSubject(string(value.Subject))
	return issuerErr == nil && subjectErr == nil && launchErr == nil &&
		issuer == value.Issuer && subject == value.Subject && string(launchSubject) == string(value.Subject)
}

type ProductionAccessProvisionCommand struct {
	Identity   ProductionAccessIdentity
	IdentityID identity.IdentityID
	AccountID  identity.AccountID
	VaultID    identity.VaultID
	Grant      entitlement.LimitedAccessGrant
	WriteKey   cryptocontent.VaultDEKMetadata
	CreatedAt  int64
}

func ValidateProductionAccessProvisionCommand(command ProductionAccessProvisionCommand) error {
	if !ValidProductionAccessIdentity(command.Identity) ||
		!validIdentityID(command.IdentityID) || !validAccountID(command.AccountID) || !validVaultID(command.VaultID) ||
		command.CreatedAt < 0 || command.CreatedAt > cryptocontent.MaximumSafeInteger ||
		!entitlement.ValidLimitedAccessGrant(command.Grant) || command.Grant.RevokedAt != nil ||
		command.Grant.AccountID != command.AccountID || command.Grant.VaultID != command.VaultID ||
		command.Grant.GrantedAt != command.CreatedAt ||
		cryptocontent.ValidateVaultDEKMetadata(command.WriteKey) != nil ||
		command.WriteKey.VaultID != command.VaultID || command.WriteKey.DEKVersion != 1 {
		return ErrProductionAccess
	}
	return nil
}

type ProductionAccessProvisionKind string

const (
	ProductionAccessCreated  ProductionAccessProvisionKind = "created"
	ProductionAccessReplayed ProductionAccessProvisionKind = "replayed"
)

type ProductionAccessProvisionResult struct {
	Kind       ProductionAccessProvisionKind
	IdentityID identity.IdentityID
	AccountID  identity.AccountID
	VaultID    identity.VaultID
}

type ProductionAccessRevokeCommand struct {
	Identity                ProductionAccessIdentity
	RevokedAtMilli          int64
	SessionRevokedAtSeconds int64
}

func ValidateProductionAccessRevokeCommand(command ProductionAccessRevokeCommand) error {
	if !ValidProductionAccessIdentity(command.Identity) || command.RevokedAtMilli < 0 ||
		command.RevokedAtMilli > cryptocontent.MaximumSafeInteger || command.SessionRevokedAtSeconds < 0 ||
		command.SessionRevokedAtSeconds > identity.MaximumSafeInteger ||
		command.SessionRevokedAtSeconds != command.RevokedAtMilli/1_000 {
		return ErrProductionAccess
	}
	return nil
}

type ProductionAccessRevokeKind string

const (
	ProductionAccessRevoked        ProductionAccessRevokeKind = "revoked"
	ProductionAccessAlreadyRevoked ProductionAccessRevokeKind = "already-revoked"
)

type ProductionAccessRevokeResult struct {
	Kind            ProductionAccessRevokeKind
	AccountID       identity.AccountID
	VaultID         identity.VaultID
	SessionsRevoked int64
}

func validIdentityID(value identity.IdentityID) bool {
	parsed, err := identity.ParseIdentityID(string(value))
	return err == nil && parsed == value
}

func validAccountID(value identity.AccountID) bool {
	parsed, err := identity.ParseAccountID(string(value))
	return err == nil && parsed == value
}

func validVaultID(value identity.VaultID) bool {
	parsed, err := identity.ParseVaultID(string(value))
	return err == nil && parsed == value
}
