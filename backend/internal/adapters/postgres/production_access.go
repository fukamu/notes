package postgres

import (
	"context"
	"errors"
	"strings"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrProductionAccessConflict = errors.New("production access state conflicts with requested state")
	ErrProductionAccessNotFound = errors.New("production access identity not found")
)

type ProductionAccessStore struct {
	pool *pgxpool.Pool
}

func NewProductionAccessStore(pool *pgxpool.Pool) (*ProductionAccessStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &ProductionAccessStore{pool: pool}, nil
}

// FindProvisioned returns an idempotent replay before a new KMS Encrypt call is
// made. A partially different existing grant fails closed instead of silently
// extending access or changing a Vault's write key.
func (store *ProductionAccessStore) FindProvisioned(
	ctx context.Context,
	key operations.ProductionAccessIdentity,
	expiresAt int64,
	limits entitlement.PersonalVaultLimits,
	keyVersionReference string,
) (*operations.ProductionAccessProvisionResult, error) {
	if store == nil || store.pool == nil || ctx == nil || !operations.ValidProductionAccessIdentity(key) ||
		expiresAt < 1 || expiresAt > entitlement.MaximumSafeInteger ||
		!entitlement.ValidPersonalVaultLimits(limits) || len(keyVersionReference) < 1 ||
		len(keyVersionReference) > 2_048 || strings.ContainsAny(keyVersionReference, "\r\n\x00") {
		return nil, operations.ErrProductionAccess
	}
	var result *operations.ProductionAccessProvisionResult
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		if err := lockProductionAccessSubject(ctx, transaction, key); err != nil {
			return err
		}
		if err := requireRestrictedProductionMode(ctx, transaction); err != nil {
			return err
		}
		existing, found, err := readProductionAccess(ctx, transaction, key)
		if err != nil || !found {
			return err
		}
		if !existing.allowed || existing.grant.RevokedAt != nil ||
			existing.grant.ExpiresAt != expiresAt || existing.grant.VaultLimits != limits ||
			existing.writeKey.DEKVersion != 1 || existing.writeKey.KEKReference != keyVersionReference {
			return ErrProductionAccessConflict
		}
		value := operations.ProductionAccessProvisionResult{
			Kind: operations.ProductionAccessReplayed, IdentityID: existing.identityID,
			AccountID: existing.accountID, VaultID: existing.vaultID,
		}
		result = &value
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

func (store *ProductionAccessStore) Provision(
	ctx context.Context,
	command operations.ProductionAccessProvisionCommand,
) (operations.ProductionAccessProvisionResult, error) {
	if store == nil || store.pool == nil || ctx == nil ||
		operations.ValidateProductionAccessProvisionCommand(command) != nil {
		return operations.ProductionAccessProvisionResult{}, operations.ErrProductionAccess
	}
	result := operations.ProductionAccessProvisionResult{}
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		if err := lockProductionAccessSubject(ctx, transaction, command.Identity); err != nil {
			return err
		}
		if err := requireRestrictedProductionMode(ctx, transaction); err != nil {
			return err
		}
		existing, found, err := readProductionAccess(ctx, transaction, command.Identity)
		if err != nil {
			return err
		}
		if found {
			if !existingMatchesProvision(existing, command) {
				return ErrProductionAccessConflict
			}
			result = operations.ProductionAccessProvisionResult{
				Kind: operations.ProductionAccessReplayed, IdentityID: existing.identityID,
				AccountID: existing.accountID, VaultID: existing.vaultID,
			}
			return nil
		}
		if err := insertProductionAccess(ctx, transaction, command); err != nil {
			if isSignupConstraintViolation(err) {
				return ErrProductionAccessConflict
			}
			return err
		}
		result = operations.ProductionAccessProvisionResult{
			Kind: operations.ProductionAccessCreated, IdentityID: command.IdentityID,
			AccountID: command.AccountID, VaultID: command.VaultID,
		}
		return nil
	})
	if err != nil {
		return operations.ProductionAccessProvisionResult{}, err
	}
	return result, nil
}

func (store *ProductionAccessStore) Revoke(
	ctx context.Context,
	command operations.ProductionAccessRevokeCommand,
) (operations.ProductionAccessRevokeResult, error) {
	if store == nil || store.pool == nil || ctx == nil ||
		operations.ValidateProductionAccessRevokeCommand(command) != nil {
		return operations.ProductionAccessRevokeResult{}, operations.ErrProductionAccess
	}
	result := operations.ProductionAccessRevokeResult{}
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		if err := lockProductionAccessSubject(ctx, transaction, command.Identity); err != nil {
			return err
		}
		if err := requirePrivateLaunchMode(ctx, transaction); err != nil {
			return err
		}
		existing, found, err := readProductionAccess(ctx, transaction, command.Identity)
		if err != nil {
			return err
		}
		if !found {
			return ErrProductionAccessNotFound
		}
		if command.RevokedAtMilli < existing.grant.GrantedAt {
			return operations.ErrProductionAccess
		}
		changed := existing.allowed || existing.grant.RevokedAt == nil
		if _, err := transaction.Exec(
			ctx, "DELETE FROM launch_allowed_users WHERE user_id = $1", string(command.Identity.Subject),
		); err != nil {
			return err
		}
		if _, err := transaction.Exec(
			ctx,
			`UPDATE limited_access_grants SET revoked_at = $1
			  WHERE account_id = $2 AND vault_id = $3 AND revoked_at IS NULL`,
			command.RevokedAtMilli, string(existing.accountID), string(existing.vaultID),
		); err != nil {
			return err
		}
		sessions, err := transaction.Exec(
			ctx,
			`UPDATE sessions SET revoked_at = $1, revocation_reason = 'security'
			  WHERE account_id = $2 AND vault_id = $3 AND revoked_at IS NULL
			    AND issued_at <= $1`,
			command.SessionRevokedAtSeconds, string(existing.accountID), string(existing.vaultID),
		)
		if err != nil {
			return err
		}
		if sessions.RowsAffected() > 0 {
			changed = true
		}
		kind := operations.ProductionAccessAlreadyRevoked
		if changed {
			kind = operations.ProductionAccessRevoked
		}
		result = operations.ProductionAccessRevokeResult{
			Kind: kind, AccountID: existing.accountID, VaultID: existing.vaultID,
			SessionsRevoked: sessions.RowsAffected(),
		}
		return nil
	})
	if err != nil {
		return operations.ProductionAccessRevokeResult{}, err
	}
	return result, nil
}

type storedProductionAccess struct {
	identityID identity.IdentityID
	accountID  identity.AccountID
	vaultID    identity.VaultID
	allowed    bool
	grant      entitlement.LimitedAccessGrant
	writeKey   cryptocontent.VaultDEKMetadata
}

func readProductionAccess(
	ctx context.Context,
	transaction pgx.Tx,
	key operations.ProductionAccessIdentity,
) (storedProductionAccess, bool, error) {
	var rawIdentityID, rawAccountID, rawVaultID string
	err := transaction.QueryRow(
		ctx,
		`SELECT identity.identity_id, identity.account_id, vault.vault_id
		   FROM identities identity
		   JOIN personal_vaults vault ON vault.account_id = identity.account_id
		  WHERE identity.provider = 'google-oidc' AND identity.issuer = $1 AND identity.subject = $2
		  FOR UPDATE OF identity, vault`,
		string(key.Issuer), string(key.Subject),
	).Scan(&rawIdentityID, &rawAccountID, &rawVaultID)
	if errors.Is(err, pgx.ErrNoRows) {
		return storedProductionAccess{}, false, nil
	}
	if err != nil {
		return storedProductionAccess{}, false, err
	}
	identityID, identityErr := identity.ParseIdentityID(rawIdentityID)
	accountID, accountErr := identity.ParseAccountID(rawAccountID)
	vaultID, vaultErr := identity.ParseVaultID(rawVaultID)
	if identityErr != nil || accountErr != nil || vaultErr != nil {
		return storedProductionAccess{}, false, ErrProductionAccessConflict
	}
	var allowed bool
	if err := transaction.QueryRow(
		ctx, "SELECT EXISTS (SELECT 1 FROM launch_allowed_users WHERE user_id = $1)", string(key.Subject),
	).Scan(&allowed); err != nil {
		return storedProductionAccess{}, false, err
	}
	grant, err := scanLimitedAccessGrant(transaction.QueryRow(
		ctx, `SELECT `+limitedAccessColumns+` FROM limited_access_grants
		       WHERE account_id = $1 AND vault_id = $2 FOR UPDATE`, rawAccountID, rawVaultID,
	))
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return storedProductionAccess{}, false, ErrProductionAccessConflict
		}
		return storedProductionAccess{}, false, err
	}
	var rawKEKReference, rawWrappedDEK string
	var rawVersion, createdAt int64
	var isWriteKey bool
	err = transaction.QueryRow(
		ctx,
		`SELECT dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
		   FROM vault_dek_versions WHERE vault_id = $1 AND is_write_key = true FOR UPDATE`,
		rawVaultID,
	).Scan(&rawVersion, &rawKEKReference, &rawWrappedDEK, &isWriteKey, &createdAt)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			return storedProductionAccess{}, false, ErrProductionAccessConflict
		}
		return storedProductionAccess{}, false, err
	}
	version, versionErr := cryptocontent.ParseDEKVersion(rawVersion)
	metadata := cryptocontent.VaultDEKMetadata{
		VaultID: vaultID, DEKVersion: version, KEKReference: rawKEKReference,
		WrappedDEK: rawWrappedDEK, CreatedAtMilli: createdAt,
	}
	if versionErr != nil || !isWriteKey || cryptocontent.ValidateVaultDEKMetadata(metadata) != nil {
		return storedProductionAccess{}, false, ErrProductionAccessConflict
	}
	return storedProductionAccess{
		identityID: identityID, accountID: accountID, vaultID: vaultID,
		allowed: allowed, grant: grant, writeKey: metadata,
	}, true, nil
}

func existingMatchesProvision(
	existing storedProductionAccess,
	command operations.ProductionAccessProvisionCommand,
) bool {
	want := command.Grant
	got := existing.grant
	return existing.allowed && got.RevokedAt == nil && got.AccountID == existing.accountID &&
		got.VaultID == existing.vaultID && got.ExpiresAt == want.ExpiresAt &&
		got.VaultLimits == want.VaultLimits && existing.writeKey.DEKVersion == 1 &&
		existing.writeKey.KEKReference == command.WriteKey.KEKReference
}

func insertProductionAccess(
	ctx context.Context,
	transaction pgx.Tx,
	command operations.ProductionAccessProvisionCommand,
) error {
	limits := command.Grant.VaultLimits
	statements := []struct {
		query string
		args  []any
	}{
		{`INSERT INTO accounts(account_id, created_at) VALUES ($1, $2)`, []any{string(command.AccountID), command.CreatedAt}},
		{`INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES ($1, $2, $3)`, []any{string(command.VaultID), string(command.AccountID), command.CreatedAt}},
		{`INSERT INTO identities(identity_id, account_id, provider, issuer, subject, created_at)
		  VALUES ($1, $2, 'google-oidc', $3, $4, $5)`, []any{
			string(command.IdentityID), string(command.AccountID), string(command.Identity.Issuer),
			string(command.Identity.Subject), command.CreatedAt,
		}},
		{`INSERT INTO launch_allowed_users(user_id, created_at) VALUES ($1, $2)`, []any{string(command.Identity.Subject), command.CreatedAt}},
		{`INSERT INTO limited_access_grants(` + limitedAccessColumns + `)
		  VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8)`, []any{
			string(command.AccountID), string(command.VaultID), command.Grant.GrantedAt,
			command.Grant.ExpiresAt, limits.ActiveCards, limits.DisplayCharactersPerCard,
			limits.SerializedPlaintextBytesPerCard, limits.PlaintextBytesPerVault,
		}},
		{`INSERT INTO vault_dek_versions(
		    vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
		  ) VALUES ($1, $2, $3, $4, true, $5)`, []any{
			string(command.VaultID), int64(command.WriteKey.DEKVersion), command.WriteKey.KEKReference,
			command.WriteKey.WrappedDEK, command.WriteKey.CreatedAtMilli,
		}},
	}
	for _, statement := range statements {
		if _, err := transaction.Exec(ctx, statement.query, statement.args...); err != nil {
			return err
		}
	}
	return nil
}

func lockProductionAccessSubject(
	ctx context.Context,
	transaction pgx.Tx,
	key operations.ProductionAccessIdentity,
) error {
	_, err := transaction.Exec(
		ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 7321))`, string(key.Subject),
	)
	return err
}

func requirePrivateLaunchMode(ctx context.Context, transaction pgx.Tx) error {
	var public bool
	if err := transaction.QueryRow(
		ctx, "SELECT public_access_enabled FROM launch_config WHERE singleton = 1 FOR UPDATE",
	).Scan(&public); err != nil || public {
		return ErrProductionAccessConflict
	}
	return nil
}

func requireRestrictedProductionMode(ctx context.Context, transaction pgx.Tx) error {
	if err := requirePrivateLaunchMode(ctx, transaction); err != nil {
		return err
	}
	var checkout pgtype.Bool
	if err := transaction.QueryRow(
		ctx, "SELECT globally_enabled FROM feature_flags WHERE flag_name = 'billing-checkout' FOR UPDATE",
	).Scan(&checkout); err != nil || !checkout.Valid || checkout.Bool {
		return ErrProductionAccessConflict
	}
	return nil
}
