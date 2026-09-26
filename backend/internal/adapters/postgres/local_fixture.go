package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/cryptocontent"
	fixture "github.com/fukamu/notes/backend/internal/localfixture"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidLocalFixture  = errors.New("invalid local fixture database operation")
	ErrLocalFixtureConflict = errors.New("local fixture database state does not match")
)

type LocalFixtureStore struct {
	pool *pgxpool.Pool
	seed fixture.Seed
}

type localFixtureQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func NewLocalFixtureStore(pool *pgxpool.Pool, seed fixture.Seed) (*LocalFixtureStore, error) {
	if pool == nil || !fixture.ValidSeed(seed) {
		return nil, ErrInvalidLocalFixture
	}
	return &LocalFixtureStore{pool: pool, seed: seed}, nil
}

func (store *LocalFixtureStore) Seed(ctx context.Context) error {
	if store == nil || store.pool == nil || !fixture.ValidSeed(store.seed) {
		return ErrInvalidLocalFixture
	}
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		seed := store.seed
		if _, err := transaction.Exec(
			ctx,
			`INSERT INTO launch_allowed_users(user_id, created_at) VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`,
			string(seed.AllowedSubject), fixture.FixtureTimestamp,
		); err != nil {
			return err
		}
		if _, err := transaction.Exec(
			ctx,
			`INSERT INTO accounts(account_id, created_at) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			string(seed.Context.AccountID), fixture.FixtureTimestamp,
		); err != nil {
			return err
		}
		if _, err := transaction.Exec(
			ctx,
			`INSERT INTO personal_vaults(vault_id, account_id, created_at)
			 VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
			string(seed.Context.VaultID), string(seed.Context.AccountID), fixture.FixtureTimestamp,
		); err != nil {
			return err
		}
		if _, err := transaction.Exec(
			ctx,
			`INSERT INTO sessions(
			 session_id, account_id, vault_id, token_hash, session_epoch, issued_at, expires_at,
			 revoked_at, revocation_reason
			 ) VALUES ($1,$2,$3,$4,$5,$6,$7,NULL,NULL) ON CONFLICT DO NOTHING`,
			string(seed.Session.SessionID), string(seed.Session.AccountID), string(seed.Session.VaultID),
			string(seed.TokenHash), int64(seed.Session.SessionEpoch), seed.Session.IssuedAt, seed.Session.ExpiresAt,
		); err != nil {
			return err
		}
		if _, err := insertSubscription(ctx, transaction, seed.Subscription); err != nil {
			return err
		}
		if _, err := transaction.Exec(
			ctx,
			`INSERT INTO entitlement_projections(
			 account_id, vault_id, version, source_subscription_id, source_billing_version,
			 state, valid_until, lock_reason, checked_at, created_at, updated_at
			 ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT DO NOTHING`,
			projectionBindings(seed.Entitlement)...,
		); err != nil {
			return err
		}
		if _, err := transaction.Exec(
			ctx,
			`INSERT INTO vault_dek_versions(
			 vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
			 ) VALUES ($1,$2,$3,$4,true,$5) ON CONFLICT DO NOTHING`,
			string(seed.DEK.VaultID), int64(seed.DEK.DEKVersion), seed.DEK.KEKReference,
			seed.DEK.WrappedDEK, seed.DEK.CreatedAtMilli,
		); err != nil {
			return err
		}
		return checkLocalFixture(ctx, transaction, seed)
	})
	if err != nil {
		return ErrLocalFixtureConflict
	}
	return nil
}

func (store *LocalFixtureStore) Check(ctx context.Context) error {
	if store == nil || store.pool == nil || !fixture.ValidSeed(store.seed) {
		return ErrInvalidLocalFixture
	}
	if err := checkLocalFixture(ctx, store.pool, store.seed); err != nil {
		return ErrLocalFixtureConflict
	}
	return nil
}

func checkLocalFixture(ctx context.Context, query localFixtureQuerier, seed fixture.Seed) error {
	if err := ensureExclusiveLocalFixtureScope(ctx, query, seed); err != nil {
		return err
	}
	var launchCreatedAt int64
	var launchCount int64
	if err := query.QueryRow(
		ctx, `SELECT created_at FROM launch_allowed_users WHERE user_id = $1`, string(seed.AllowedSubject),
	).Scan(&launchCreatedAt); err != nil || launchCreatedAt != fixture.FixtureTimestamp {
		return ErrLocalFixtureConflict
	}
	if err := query.QueryRow(ctx, `SELECT COUNT(*) FROM launch_allowed_users`).Scan(&launchCount); err != nil || launchCount != 1 {
		return ErrLocalFixtureConflict
	}
	var accountCreatedAt int64
	if err := query.QueryRow(
		ctx, `SELECT created_at FROM accounts WHERE account_id = $1`, string(seed.Context.AccountID),
	).Scan(&accountCreatedAt); err != nil || accountCreatedAt != fixture.FixtureTimestamp {
		return ErrLocalFixtureConflict
	}
	var owner string
	var vaultCreatedAt int64
	if err := query.QueryRow(
		ctx, `SELECT account_id, created_at FROM personal_vaults WHERE vault_id = $1`, string(seed.Context.VaultID),
	).Scan(&owner, &vaultCreatedAt); err != nil || owner != string(seed.Context.AccountID) ||
		vaultCreatedAt != fixture.FixtureTimestamp {
		return ErrLocalFixtureConflict
	}
	storedSession, err := scanStoredSession(query.QueryRow(
		ctx,
		`SELECT session_id, account_id, vault_id, token_hash, session_epoch,
		 issued_at, expires_at, revoked_at, revocation_reason
		 FROM sessions WHERE session_id = $1`,
		string(seed.Session.SessionID),
	))
	if err != nil || storedSession.Session != seed.Session || storedSession.TokenHash != seed.TokenHash {
		return ErrLocalFixtureConflict
	}
	storedSubscription, err := scanSubscription(query.QueryRow(
		ctx, subscriptionSelect+" WHERE subscription_id = $1", string(seed.Subscription.SubscriptionID),
	))
	if err != nil || !sameFixtureSubscription(storedSubscription, seed.Subscription) {
		return ErrLocalFixtureConflict
	}
	storedProjection, err := scanProjection(query.QueryRow(
		ctx,
		projectionSelect+" WHERE projection.account_id = $1 AND projection.vault_id = $2",
		string(seed.Context.AccountID), string(seed.Context.VaultID),
	))
	if err != nil || storedProjection != seed.Entitlement {
		return ErrLocalFixtureConflict
	}
	var storedDEK cryptocontent.VaultDEKMetadata
	var rawVault string
	var rawVersion int64
	var writeKey bool
	if err := query.QueryRow(
		ctx,
		`SELECT vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
		 FROM vault_dek_versions WHERE vault_id = $1 AND dek_version = $2`,
		string(seed.DEK.VaultID), int64(seed.DEK.DEKVersion),
	).Scan(
		&rawVault, &rawVersion, &storedDEK.KEKReference, &storedDEK.WrappedDEK,
		&writeKey, &storedDEK.CreatedAtMilli,
	); err != nil || rawVault != string(seed.DEK.VaultID) || rawVersion != int64(seed.DEK.DEKVersion) || !writeKey {
		return ErrLocalFixtureConflict
	}
	storedDEK.VaultID = seed.DEK.VaultID
	storedDEK.DEKVersion = seed.DEK.DEKVersion
	if storedDEK != seed.DEK {
		return ErrLocalFixtureConflict
	}
	return nil
}

func ensureExclusiveLocalFixtureScope(ctx context.Context, query localFixtureQuerier, seed fixture.Seed) error {
	checks := []struct {
		statement string
		values    []any
	}{
		{
			statement: `SELECT COUNT(*) FROM accounts WHERE account_id <> $1`,
			values:    []any{string(seed.Context.AccountID)},
		},
		{
			statement: `SELECT COUNT(*) FROM personal_vaults WHERE account_id <> $1 OR vault_id <> $2`,
			values:    []any{string(seed.Context.AccountID), string(seed.Context.VaultID)},
		},
		{
			statement: `SELECT COUNT(*) FROM identities WHERE account_id <> $1`,
			values:    []any{string(seed.Context.AccountID)},
		},
		{
			statement: `SELECT COUNT(*) FROM sessions WHERE account_id <> $1 OR vault_id <> $2`,
			values:    []any{string(seed.Context.AccountID), string(seed.Context.VaultID)},
		},
		{
			statement: `SELECT COUNT(*) FROM billing_subscriptions WHERE account_id <> $1 OR vault_id <> $2`,
			values:    []any{string(seed.Context.AccountID), string(seed.Context.VaultID)},
		},
		{
			statement: `SELECT COUNT(*) FROM entitlement_projections WHERE account_id <> $1 OR vault_id <> $2`,
			values:    []any{string(seed.Context.AccountID), string(seed.Context.VaultID)},
		},
		{
			statement: `SELECT COUNT(*) FROM vault_dek_versions WHERE vault_id <> $1`,
			values:    []any{string(seed.Context.VaultID)},
		},
	}
	for _, check := range checks {
		var count int64
		if err := query.QueryRow(ctx, check.statement, check.values...).Scan(&count); err != nil || count != 0 {
			return ErrLocalFixtureConflict
		}
	}
	return nil
}

func sameFixtureSubscription(left billing.SubscriptionRecord, right billing.SubscriptionRecord) bool {
	return left.SubscriptionID == right.SubscriptionID && left.AccountID == right.AccountID &&
		left.VaultID == right.VaultID && left.Provider == right.Provider &&
		left.ProviderCustomerReference == right.ProviderCustomerReference &&
		left.ProviderSubscriptionReference == right.ProviderSubscriptionReference &&
		left.Version == right.Version && left.Lifecycle == right.Lifecycle &&
		left.PaymentMethodReady == right.PaymentMethodReady &&
		sameOptionalTimestamp(left.PaymentMethodUpdatedAt, right.PaymentMethodUpdatedAt) &&
		sameOptionalTimestamp(left.TrialObservedAt, right.TrialObservedAt) &&
		sameOptionalTimestamp(left.LastPaidAt, right.LastPaidAt) &&
		left.LastPaidInvoiceReference == right.LastPaidInvoiceReference &&
		sameOptionalTimestamp(left.LastDelinquencyAt, right.LastDelinquencyAt) &&
		sameOptionalTimestamp(left.CancellationUpdatedAt, right.CancellationUpdatedAt) &&
		sameOptionalTimestamp(left.CancelAt, right.CancelAt) &&
		sameOptionalTimestamp(left.LastReconciledAt, right.LastReconciledAt) &&
		left.CreatedAt == right.CreatedAt && left.UpdatedAt == right.UpdatedAt
}
