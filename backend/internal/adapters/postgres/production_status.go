package postgres

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type ProductionStatusDatabaseFacts struct {
	LaunchConfigRows           int64
	PublicAccessEnabled        bool
	BillingCheckoutFlagRows    int64
	BillingCheckoutEnabled     bool
	Accounts                   int64
	Vaults                     int64
	GoogleIdentities           int64
	AllowedUsers               int64
	ActiveLimitedGrants        int64
	ExpiredUnrevokedGrants     int64
	ActiveSessions             int64
	WrappedKeyVersions         int64
	WriteKeys                  int64
	EncryptedObjects           int64
	PendingEncryptedWrites     int64
	PendingObjectDeletes       int64
	NonceReservations          int64
	AccessInconsistencies      int64
	CryptographicInconsistency int64
}

type ProductionStatusStore struct {
	pool *pgxpool.Pool
}

func NewProductionStatusStore(pool *pgxpool.Pool) (*ProductionStatusStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &ProductionStatusStore{pool: pool}, nil
}

func (store *ProductionStatusStore) Read(
	ctx context.Context,
	observedAtMillis int64,
) (ProductionStatusDatabaseFacts, error) {
	if store == nil || store.pool == nil || ctx == nil || observedAtMillis < 0 {
		return ProductionStatusDatabaseFacts{}, errors.New("production status input invalid")
	}
	transaction, err := store.pool.BeginTx(ctx, pgx.TxOptions{
		IsoLevel: pgx.RepeatableRead, AccessMode: pgx.ReadOnly,
	})
	if err != nil {
		return ProductionStatusDatabaseFacts{}, errors.New("begin production status snapshot")
	}
	defer func() { _ = transaction.Rollback(ctx) }()
	facts := ProductionStatusDatabaseFacts{}
	if err := transaction.QueryRow(
		ctx,
		`SELECT COUNT(*), COALESCE(bool_or(public_access_enabled), false)
		   FROM launch_config WHERE singleton = 1`,
	).Scan(&facts.LaunchConfigRows, &facts.PublicAccessEnabled); err != nil {
		return ProductionStatusDatabaseFacts{}, errors.New("inspect production launch configuration")
	}
	if err := transaction.QueryRow(
		ctx,
		`SELECT COUNT(*), COALESCE(bool_or(globally_enabled), false)
		   FROM feature_flags WHERE flag_name = 'billing-checkout'`,
	).Scan(&facts.BillingCheckoutFlagRows, &facts.BillingCheckoutEnabled); err != nil {
		return ProductionStatusDatabaseFacts{}, errors.New("inspect production billing flag")
	}
	if err := transaction.QueryRow(
		ctx,
		`SELECT
		   (SELECT COUNT(*) FROM accounts),
		   (SELECT COUNT(*) FROM personal_vaults),
		   (SELECT COUNT(*) FROM identities WHERE provider = 'google-oidc'),
		   (SELECT COUNT(*) FROM launch_allowed_users),
		   (SELECT COUNT(*) FROM limited_access_grants
		     WHERE revoked_at IS NULL AND expires_at > $1),
		   (SELECT COUNT(*) FROM limited_access_grants
		     WHERE revoked_at IS NULL AND expires_at <= $1),
		   (SELECT COUNT(*) FROM sessions
		     WHERE revoked_at IS NULL AND expires_at > $2),
		   (SELECT COUNT(*) FROM vault_dek_versions),
		   (SELECT COUNT(*) FROM vault_dek_versions WHERE is_write_key),
		   (SELECT COUNT(*) FROM vault_encrypted_objects),
		   (SELECT COUNT(*) FROM vault_encrypted_write_intents),
		   (SELECT COUNT(*) FROM vault_object_delete_outbox),
		   (SELECT COUNT(*) FROM content_nonce_reservations)`,
		observedAtMillis,
		observedAtMillis/1_000,
	).Scan(
		&facts.Accounts, &facts.Vaults, &facts.GoogleIdentities, &facts.AllowedUsers,
		&facts.ActiveLimitedGrants, &facts.ExpiredUnrevokedGrants, &facts.ActiveSessions,
		&facts.WrappedKeyVersions, &facts.WriteKeys, &facts.EncryptedObjects,
		&facts.PendingEncryptedWrites, &facts.PendingObjectDeletes, &facts.NonceReservations,
	); err != nil {
		return ProductionStatusDatabaseFacts{}, errors.New("inspect production aggregate state")
	}
	if err := transaction.QueryRow(
		ctx,
		`SELECT
		   (SELECT COUNT(*) FROM launch_allowed_users allowed
		     WHERE NOT EXISTS (
		       SELECT 1 FROM identities identity
		       JOIN personal_vaults vault ON vault.account_id = identity.account_id
		       JOIN limited_access_grants access_grant
		         ON access_grant.account_id = vault.account_id AND access_grant.vault_id = vault.vault_id
		       JOIN vault_dek_versions write_key
		         ON write_key.vault_id = vault.vault_id AND write_key.is_write_key
		       WHERE identity.provider = 'google-oidc'
		         AND identity.subject = allowed.user_id
		         AND access_grant.revoked_at IS NULL AND access_grant.expires_at > $1
		     ))
		 + (SELECT COUNT(*) FROM limited_access_grants access_grant
		     WHERE access_grant.revoked_at IS NULL AND access_grant.expires_at > $1
		       AND NOT EXISTS (
		         SELECT 1 FROM identities identity
		         JOIN launch_allowed_users allowed ON allowed.user_id = identity.subject
		         WHERE identity.provider = 'google-oidc'
		           AND identity.account_id = access_grant.account_id
		       ))
		 + (SELECT COUNT(*) FROM sessions user_session
		     WHERE user_session.revoked_at IS NULL AND user_session.expires_at > $2
		       AND NOT EXISTS (
		         SELECT 1 FROM session_identities binding
		         JOIN identities identity ON identity.identity_id = binding.identity_id
		         WHERE binding.session_id = user_session.session_id
		           AND identity.account_id = user_session.account_id
		           AND identity.provider = 'google-oidc'
		       ))
		 + (SELECT COUNT(*) FROM accounts account
		     WHERE (SELECT COUNT(*) FROM personal_vaults vault
		            WHERE vault.account_id = account.account_id) <> 1)`,
		observedAtMillis,
		observedAtMillis/1_000,
	).Scan(&facts.AccessInconsistencies); err != nil {
		return ProductionStatusDatabaseFacts{}, errors.New("inspect production access consistency")
	}
	if err := transaction.QueryRow(
		ctx,
		`SELECT
		   (SELECT COUNT(*) FROM personal_vaults vault
		     WHERE (SELECT COUNT(*) FROM vault_dek_versions write_key
		            WHERE write_key.vault_id = vault.vault_id AND write_key.is_write_key) <> 1)
		 + (SELECT COUNT(*) FROM vault_encrypted_objects encrypted_object
		     WHERE NOT EXISTS (
		       SELECT 1 FROM vault_dek_versions key_version
		       WHERE key_version.vault_id = encrypted_object.vault_id
		         AND key_version.dek_version = encrypted_object.dek_version
		     ))
		 + (SELECT COUNT(*) FROM vault_encrypted_write_intents intent
		     WHERE NOT EXISTS (
		       SELECT 1 FROM vault_dek_versions key_version
		       WHERE key_version.vault_id = intent.vault_id AND key_version.dek_version = intent.dek_version
		     ))`,
	).Scan(&facts.CryptographicInconsistency); err != nil {
		return ProductionStatusDatabaseFacts{}, errors.New("inspect production cryptographic consistency")
	}
	if err := transaction.Commit(ctx); err != nil {
		return ProductionStatusDatabaseFacts{}, errors.New("commit production status snapshot")
	}
	return facts, nil
}
