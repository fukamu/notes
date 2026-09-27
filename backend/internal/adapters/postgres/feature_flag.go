package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/featureflag"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidFeatureFlagOperation = errors.New("invalid feature flag operation")

type FeatureFlagStore struct {
	pool *pgxpool.Pool
}

var _ featureflag.Reader = (*FeatureFlagStore)(nil)

func NewFeatureFlagStore(pool *pgxpool.Pool) (*FeatureFlagStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &FeatureFlagStore{pool: pool}, nil
}

func (store *FeatureFlagStore) Read(
	ctx context.Context,
	name featureflag.Name,
	accountID identity.AccountID,
) (featureflag.Facts, error) {
	if store == nil || store.pool == nil || ctx == nil ||
		!validFeatureFlagInput(name, accountID) {
		return featureflag.Facts{}, ErrInvalidFeatureFlagOperation
	}
	facts := featureflag.Facts{Configured: true}
	err := store.pool.QueryRow(
		ctx,
		`SELECT flag.globally_enabled, EXISTS(
		   SELECT 1 FROM feature_flag_accounts account_flag
		    WHERE account_flag.flag_name = flag.flag_name
		      AND account_flag.account_id = $2
		 )
		 FROM feature_flags flag WHERE flag.flag_name = $1`,
		string(name), string(accountID),
	).Scan(&facts.GloballyEnabled, &facts.AccountEnabled)
	if errors.Is(err, pgx.ErrNoRows) {
		return featureflag.Facts{}, nil
	}
	if err != nil {
		return featureflag.Facts{}, err
	}
	return facts, nil
}

func (store *FeatureFlagStore) Configure(
	ctx context.Context,
	name featureflag.Name,
	globallyEnabled bool,
	updatedAt int64,
) error {
	if store == nil || store.pool == nil || ctx == nil ||
		!validFeatureFlagName(name) || !validFeatureFlagTimestamp(updatedAt) {
		return ErrInvalidFeatureFlagOperation
	}
	_, err := store.pool.Exec(
		ctx,
		`INSERT INTO feature_flags(flag_name, globally_enabled, updated_at)
		 VALUES ($1, $2, $3)
		 ON CONFLICT (flag_name) DO UPDATE SET
		 globally_enabled = EXCLUDED.globally_enabled,
		 updated_at = EXCLUDED.updated_at
		 WHERE feature_flags.updated_at <= EXCLUDED.updated_at`,
		string(name), globallyEnabled, updatedAt,
	)
	return classifyFeatureFlagWriteError(err)
}

func (store *FeatureFlagStore) SetAccountEnabled(
	ctx context.Context,
	name featureflag.Name,
	accountID identity.AccountID,
	enabled bool,
	changedAt int64,
) error {
	if store == nil || store.pool == nil || ctx == nil ||
		!validFeatureFlagInput(name, accountID) || !validFeatureFlagTimestamp(changedAt) {
		return ErrInvalidFeatureFlagOperation
	}
	var err error
	if enabled {
		_, err = store.pool.Exec(
			ctx,
			`INSERT INTO feature_flag_accounts(flag_name, account_id, enabled_at)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (flag_name, account_id) DO UPDATE SET
			 enabled_at = EXCLUDED.enabled_at
			 WHERE feature_flag_accounts.enabled_at <= EXCLUDED.enabled_at`,
			string(name), string(accountID), changedAt,
		)
	} else {
		_, err = store.pool.Exec(
			ctx,
			`DELETE FROM feature_flag_accounts
			 WHERE flag_name = $1 AND account_id = $2`,
			string(name), string(accountID),
		)
	}
	return classifyFeatureFlagWriteError(err)
}

func validFeatureFlagInput(name featureflag.Name, accountID identity.AccountID) bool {
	if !validFeatureFlagName(name) {
		return false
	}
	_, err := identity.ParseAccountID(string(accountID))
	return err == nil
}

func validFeatureFlagName(name featureflag.Name) bool {
	parsed, err := featureflag.ParseName(string(name))
	return err == nil && parsed == name
}

func validFeatureFlagTimestamp(value int64) bool {
	return value >= 0 && value <= identity.MaximumSafeInteger
}

func classifyFeatureFlagWriteError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) &&
		(postgresError.Code == "23503" || postgresError.Code == "23514") {
		return ErrInvalidFeatureFlagOperation
	}
	return err
}
