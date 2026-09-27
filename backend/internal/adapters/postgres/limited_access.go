package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidLimitedAccessOperation = errors.New("invalid limited access operation")
	ErrInvalidStoredLimitedAccess    = errors.New("invalid stored limited access grant")
	ErrLimitedAccessConflict         = errors.New("limited access grant conflict")
)

type LimitedAccessStore struct {
	pool *pgxpool.Pool
}

var _ entitlement.LimitedAccessReader = (*LimitedAccessStore)(nil)

const limitedAccessColumns = `account_id, vault_id, granted_at, expires_at, revoked_at,
       active_cards, display_characters_per_card, serialized_plaintext_bytes_per_card,
       plaintext_bytes_per_vault`

func NewLimitedAccessStore(pool *pgxpool.Pool) (*LimitedAccessStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &LimitedAccessStore{pool: pool}, nil
}

func (store *LimitedAccessStore) FindLimitedAccessGrant(
	ctx context.Context,
	accountID identity.AccountID,
	vaultID identity.VaultID,
) (*entitlement.LimitedAccessGrant, error) {
	if store == nil || store.pool == nil || ctx == nil || !validLimitedAccessScope(accountID, vaultID) {
		return nil, ErrInvalidLimitedAccessOperation
	}
	grant, err := scanLimitedAccessGrant(store.pool.QueryRow(
		ctx,
		`SELECT `+limitedAccessColumns+` FROM limited_access_grants
		 WHERE account_id = $1 AND vault_id = $2`,
		string(accountID), string(vaultID),
	))
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &grant, nil
}

func (store *LimitedAccessStore) Create(
	ctx context.Context,
	grant entitlement.LimitedAccessGrant,
) (bool, error) {
	if store == nil || store.pool == nil || ctx == nil ||
		!entitlement.ValidLimitedAccessGrant(grant) || grant.RevokedAt != nil {
		return false, ErrInvalidLimitedAccessOperation
	}
	limits := grant.VaultLimits
	tag, err := store.pool.Exec(
		ctx,
		`INSERT INTO limited_access_grants(`+limitedAccessColumns+`)
		 VALUES ($1, $2, $3, $4, NULL, $5, $6, $7, $8)
		 ON CONFLICT DO NOTHING`,
		string(grant.AccountID), string(grant.VaultID), grant.GrantedAt, grant.ExpiresAt,
		limits.ActiveCards, limits.DisplayCharactersPerCard,
		limits.SerializedPlaintextBytesPerCard, limits.PlaintextBytesPerVault,
	)
	if err != nil {
		return false, classifyLimitedAccessWriteError(err)
	}
	if tag.RowsAffected() == 1 {
		return true, nil
	}
	existing, findErr := store.FindLimitedAccessGrant(ctx, grant.AccountID, grant.VaultID)
	if findErr != nil {
		return false, findErr
	}
	if existing != nil && *existing == grant {
		return false, nil
	}
	return false, ErrLimitedAccessConflict
}

func (store *LimitedAccessStore) Revoke(
	ctx context.Context,
	accountID identity.AccountID,
	vaultID identity.VaultID,
	revokedAt int64,
) (bool, error) {
	if store == nil || store.pool == nil || ctx == nil ||
		!validLimitedAccessScope(accountID, vaultID) || revokedAt < 0 ||
		revokedAt > entitlement.MaximumSafeInteger {
		return false, ErrInvalidLimitedAccessOperation
	}
	tag, err := store.pool.Exec(
		ctx,
		`UPDATE limited_access_grants SET revoked_at = $1
		 WHERE account_id = $2 AND vault_id = $3 AND revoked_at IS NULL
		   AND granted_at <= $1`,
		revokedAt, string(accountID), string(vaultID),
	)
	if err != nil {
		return false, classifyLimitedAccessWriteError(err)
	}
	return tag.RowsAffected() == 1, nil
}

func scanLimitedAccessGrant(row rowScanner) (entitlement.LimitedAccessGrant, error) {
	var rawAccountID, rawVaultID string
	var grantedAt, expiresAt int64
	var revokedAt pgtype.Int8
	var limits entitlement.PersonalVaultLimits
	if err := row.Scan(
		&rawAccountID, &rawVaultID, &grantedAt, &expiresAt, &revokedAt,
		&limits.ActiveCards, &limits.DisplayCharactersPerCard,
		&limits.SerializedPlaintextBytesPerCard, &limits.PlaintextBytesPerVault,
	); err != nil {
		return entitlement.LimitedAccessGrant{}, err
	}
	accountID, accountErr := identity.ParseAccountID(rawAccountID)
	vaultID, vaultErr := identity.ParseVaultID(rawVaultID)
	grant := entitlement.LimitedAccessGrant{
		AccountID: accountID, VaultID: vaultID, GrantedAt: grantedAt,
		ExpiresAt: expiresAt, VaultLimits: limits,
	}
	if revokedAt.Valid {
		value := revokedAt.Int64
		grant.RevokedAt = &value
	}
	if accountErr != nil || vaultErr != nil || !entitlement.ValidLimitedAccessGrant(grant) {
		return entitlement.LimitedAccessGrant{}, ErrInvalidStoredLimitedAccess
	}
	return grant, nil
}

func validLimitedAccessScope(accountID identity.AccountID, vaultID identity.VaultID) bool {
	_, accountErr := identity.ParseAccountID(string(accountID))
	_, vaultErr := identity.ParseVaultID(string(vaultID))
	return accountErr == nil && vaultErr == nil
}

func classifyLimitedAccessWriteError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) &&
		(postgresError.Code == "23503" || postgresError.Code == "23514") {
		return ErrInvalidLimitedAccessOperation
	}
	return err
}
