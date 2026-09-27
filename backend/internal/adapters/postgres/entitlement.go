package postgres

import (
	"context"
	"database/sql"
	"errors"

	"github.com/fukamu/notes/backend/internal/billing"
	"github.com/fukamu/notes/backend/internal/entitlement"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidEntitlementOperation = errors.New("invalid entitlement operation")
	ErrInvalidEntitlementRecord    = errors.New("invalid stored entitlement record")
)

type EntitlementStore struct {
	pool *pgxpool.Pool
}

var (
	_ entitlement.Repository    = (*EntitlementStore)(nil)
	_ entitlement.OwnershipPort = (*EntitlementStore)(nil)
)

const projectionSelect = `SELECT projection.account_id, projection.vault_id,
       projection.version, projection.source_subscription_id,
       projection.source_billing_version, projection.state,
       projection.valid_until, projection.lock_reason, projection.checked_at,
       projection.created_at, projection.updated_at,
       source.account_id, source.vault_id
  FROM entitlement_projections projection
  JOIN billing_subscriptions source
    ON source.subscription_id = projection.source_subscription_id`

const leaseSelect = `SELECT lease_id, account_id, vault_id, session_id,
       session_epoch, source_subscription_id, source_billing_version,
       basis, issued_at, expires_at, revoked_at, created_at
  FROM entitlement_offline_leases`

func NewEntitlementStore(pool *pgxpool.Pool) (*EntitlementStore, error) {
	if pool == nil {
		return nil, errors.New("database pool is required")
	}
	return &EntitlementStore{pool: pool}, nil
}

func (store *EntitlementStore) Owns(ctx context.Context, vaultContext identity.VaultContext) (bool, error) {
	if store == nil || store.pool == nil || !entitlement.ValidVaultContext(vaultContext) {
		return false, ErrInvalidEntitlementOperation
	}
	var owned bool
	err := store.pool.QueryRow(
		ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM personal_vaults
		    WHERE account_id = $1 AND vault_id = $2
		 )`,
		string(vaultContext.AccountID), string(vaultContext.VaultID),
	).Scan(&owned)
	return owned, err
}

func (store *EntitlementStore) FindProjection(
	ctx context.Context,
	vaultContext identity.VaultContext,
) (*entitlement.ProjectionRecord, error) {
	if store == nil || store.pool == nil || !entitlement.ValidVaultContext(vaultContext) {
		return nil, ErrInvalidEntitlementOperation
	}
	return scanOptionalProjection(store.pool.QueryRow(
		ctx,
		projectionSelect+" WHERE projection.account_id = $1 AND projection.vault_id = $2",
		string(vaultContext.AccountID), string(vaultContext.VaultID),
	))
}

func (store *EntitlementStore) CommitProjection(
	ctx context.Context,
	expected *entitlement.ProjectionVersion,
	record entitlement.ProjectionRecord,
	revokeActiveLeasesAt *int64,
) (entitlement.ProjectionCommitKind, error) {
	if store == nil || store.pool == nil || !validProjectionCommit(expected, record, revokeActiveLeasesAt) {
		return "", ErrInvalidEntitlementOperation
	}
	result := entitlement.ProjectionConflict
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		var rowsAffected int64
		if expected == nil {
			tag, execErr := transaction.Exec(
				ctx,
				`INSERT INTO entitlement_projections(
				 account_id, vault_id, version, source_subscription_id,
				 source_billing_version, state, valid_until, lock_reason,
				 checked_at, created_at, updated_at
				) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
				ON CONFLICT (account_id, vault_id) DO NOTHING`,
				projectionBindings(record)...,
			)
			if execErr != nil {
				return execErr
			}
			rowsAffected = tag.RowsAffected()
		} else {
			tag, execErr := transaction.Exec(
				ctx,
				`UPDATE entitlement_projections SET
				 version = $1, source_subscription_id = $2,
				 source_billing_version = $3, state = $4, valid_until = $5,
				 lock_reason = $6, checked_at = $7, updated_at = $8
				WHERE account_id = $9 AND vault_id = $10 AND version = $11`,
				int64(record.Version), string(record.SourceSubscriptionID), int64(record.SourceBillingVersion),
				string(record.State.Kind), stateValidUntil(record.State), stateLockReason(record.State),
				record.CheckedAt, record.UpdatedAt, string(record.AccountID), string(record.VaultID), int64(*expected),
			)
			if execErr != nil {
				return execErr
			}
			rowsAffected = tag.RowsAffected()
		}
		if rowsAffected != 1 {
			result = entitlement.ProjectionConflict
			return nil
		}
		if revokeActiveLeasesAt != nil {
			if _, err := transaction.Exec(
				ctx,
				`UPDATE entitlement_offline_leases SET revoked_at = $1
				 WHERE account_id = $2 AND vault_id = $3 AND revoked_at IS NULL
				   AND issued_at <= $1`,
				*revokeActiveLeasesAt, string(record.AccountID), string(record.VaultID),
			); err != nil {
				return err
			}
		}
		result = entitlement.ProjectionApplied
		return nil
	})
	if isRetryableTransactionError(err) {
		return entitlement.ProjectionConflict, nil
	}
	return result, classifyEntitlementWriteError(err)
}

func (store *EntitlementStore) FindOfflineLease(
	ctx context.Context,
	vaultContext identity.VaultContext,
	leaseID entitlement.OfflineLeaseID,
) (*entitlement.OfflineLeaseRecord, error) {
	if store == nil || store.pool == nil || !entitlement.ValidVaultContext(vaultContext) {
		return nil, ErrInvalidEntitlementOperation
	}
	if _, err := entitlement.ParseOfflineLeaseID(string(leaseID)); err != nil {
		return nil, ErrInvalidEntitlementOperation
	}
	return scanOptionalOfflineLease(store.pool.QueryRow(
		ctx,
		leaseSelect+" WHERE lease_id = $1 AND account_id = $2 AND vault_id = $3",
		string(leaseID), string(vaultContext.AccountID), string(vaultContext.VaultID),
	))
}

func (store *EntitlementStore) CreateOfflineLease(
	ctx context.Context,
	expected entitlement.ProjectionVersion,
	lease entitlement.OfflineLeaseRecord,
) (entitlement.LeaseCreateResult, error) {
	if store == nil || store.pool == nil || !entitlement.ValidOfflineLeaseRecord(lease) {
		return entitlement.LeaseCreateResult{}, ErrInvalidEntitlementOperation
	}
	if _, err := entitlement.ParseProjectionVersion(int64(expected)); err != nil {
		return entitlement.LeaseCreateResult{}, ErrInvalidEntitlementOperation
	}
	result := entitlement.LeaseCreateResult{Kind: entitlement.LeaseCreateProjectionConflict}
	err := WithSerializableTx(ctx, store.pool, func(transaction pgx.Tx) error {
		projection, scanErr := scanOptionalProjection(transaction.QueryRow(
			ctx,
			projectionSelect+" WHERE projection.account_id = $1 AND projection.vault_id = $2 FOR UPDATE OF projection",
			string(lease.Context.AccountID), string(lease.Context.VaultID),
		))
		if scanErr != nil {
			return scanErr
		}
		if projection == nil {
			result.Kind = entitlement.LeaseCreateProjectionConflict
			return nil
		}
		existing, scanErr := scanOptionalOfflineLease(transaction.QueryRow(
			ctx, leaseSelect+" WHERE lease_id = $1 FOR UPDATE", string(lease.LeaseID),
		))
		if scanErr != nil {
			return scanErr
		}
		if existing != nil {
			if sameOfflineLease(*existing, lease) {
				result = entitlement.LeaseCreateResult{Kind: entitlement.LeaseCreateReplayed, Lease: existing}
			} else {
				result.Kind = entitlement.LeaseCreateIdentifierConflict
			}
			return nil
		}
		if !projectionAllowsLease(*projection, expected, lease) {
			result.Kind = entitlement.LeaseCreateProjectionConflict
			return nil
		}
		_, insertErr := transaction.Exec(
			ctx,
			`INSERT INTO entitlement_offline_leases(
			 lease_id, account_id, vault_id, session_id, session_epoch,
			 source_subscription_id, source_billing_version, basis,
			 issued_at, expires_at, revoked_at, created_at
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, $9)`,
			string(lease.LeaseID), string(lease.Context.AccountID), string(lease.Context.VaultID),
			string(lease.Context.SessionID), int64(lease.Context.SessionEpoch),
			string(lease.SourceSubscriptionID), int64(lease.SourceBillingVersion), string(lease.Basis),
			lease.IssuedAt, lease.ExpiresAt,
		)
		if insertErr != nil {
			return insertErr
		}
		result.Kind = entitlement.LeaseCreateIssued
		return nil
	})
	if isUniqueViolation(err) {
		existing, findErr := store.findOfflineLeaseByID(ctx, lease.LeaseID)
		if findErr != nil {
			return entitlement.LeaseCreateResult{}, findErr
		}
		if existing != nil && sameOfflineLease(*existing, lease) {
			return entitlement.LeaseCreateResult{Kind: entitlement.LeaseCreateReplayed, Lease: existing}, nil
		}
		return entitlement.LeaseCreateResult{Kind: entitlement.LeaseCreateIdentifierConflict}, nil
	}
	if isRetryableTransactionError(err) {
		return entitlement.LeaseCreateResult{Kind: entitlement.LeaseCreateProjectionConflict}, nil
	}
	return result, classifyEntitlementWriteError(err)
}

func (store *EntitlementStore) findOfflineLeaseByID(
	ctx context.Context,
	leaseID entitlement.OfflineLeaseID,
) (*entitlement.OfflineLeaseRecord, error) {
	return scanOptionalOfflineLease(store.pool.QueryRow(ctx, leaseSelect+" WHERE lease_id = $1", string(leaseID)))
}

func scanOptionalProjection(row rowScanner) (*entitlement.ProjectionRecord, error) {
	record, err := scanProjection(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func scanProjection(row rowScanner) (entitlement.ProjectionRecord, error) {
	var accountID, vaultID, sourceSubscriptionID, state, sourceAccountID, sourceVaultID string
	var version, sourceVersion, checkedAt, createdAt, updatedAt int64
	var validUntil sql.NullInt64
	var lockReason sql.NullString
	if err := row.Scan(
		&accountID, &vaultID, &version, &sourceSubscriptionID, &sourceVersion,
		&state, &validUntil, &lockReason, &checkedAt, &createdAt, &updatedAt,
		&sourceAccountID, &sourceVaultID,
	); err != nil {
		return entitlement.ProjectionRecord{}, err
	}
	parsedAccountID, accountErr := identity.ParseAccountID(accountID)
	parsedVaultID, vaultErr := identity.ParseVaultID(vaultID)
	parsedVersion, versionErr := entitlement.ParseProjectionVersion(version)
	parsedSubscriptionID, subscriptionErr := billing.ParseSubscriptionID(sourceSubscriptionID)
	parsedSourceVersion, sourceVersionErr := billing.ParseVersion(sourceVersion)
	record := entitlement.ProjectionRecord{
		AccountID: parsedAccountID, VaultID: parsedVaultID, Version: parsedVersion,
		SourceSubscriptionID: parsedSubscriptionID, SourceBillingVersion: parsedSourceVersion,
		State:     entitlement.State{Kind: entitlement.StateKind(state)},
		CheckedAt: checkedAt, CreatedAt: createdAt, UpdatedAt: updatedAt,
	}
	if validUntil.Valid {
		record.State.ValidUntil = validUntil.Int64
	}
	if lockReason.Valid {
		record.State.Reason = entitlement.LockReason(lockReason.String)
	}
	if accountErr != nil || vaultErr != nil || versionErr != nil || subscriptionErr != nil || sourceVersionErr != nil ||
		sourceAccountID != accountID || sourceVaultID != vaultID || !entitlement.ValidProjectionRecord(record) {
		return entitlement.ProjectionRecord{}, ErrInvalidEntitlementRecord
	}
	return record, nil
}

func scanOptionalOfflineLease(row rowScanner) (*entitlement.OfflineLeaseRecord, error) {
	record, err := scanOfflineLease(row)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &record, nil
}

func scanOfflineLease(row rowScanner) (entitlement.OfflineLeaseRecord, error) {
	var leaseID, accountID, vaultID, sessionID, sourceSubscriptionID, basis string
	var epoch, sourceVersion, issuedAt, expiresAt, createdAt int64
	var revokedAt sql.NullInt64
	if err := row.Scan(
		&leaseID, &accountID, &vaultID, &sessionID, &epoch,
		&sourceSubscriptionID, &sourceVersion, &basis, &issuedAt,
		&expiresAt, &revokedAt, &createdAt,
	); err != nil {
		return entitlement.OfflineLeaseRecord{}, err
	}
	parsedLeaseID, leaseErr := entitlement.ParseOfflineLeaseID(leaseID)
	parsedAccountID, accountErr := identity.ParseAccountID(accountID)
	parsedVaultID, vaultErr := identity.ParseVaultID(vaultID)
	parsedSessionID, sessionErr := identity.ParseSessionID(sessionID)
	parsedEpoch, epochErr := identity.ParseSessionEpoch(epoch)
	parsedSubscriptionID, subscriptionErr := billing.ParseSubscriptionID(sourceSubscriptionID)
	parsedSourceVersion, sourceVersionErr := billing.ParseVersion(sourceVersion)
	record := entitlement.OfflineLeaseRecord{
		OfflineLease: entitlement.OfflineLease{
			LeaseID: parsedLeaseID,
			Context: identity.VaultContext{
				AccountID: parsedAccountID, VaultID: parsedVaultID,
				SessionID: parsedSessionID, SessionEpoch: parsedEpoch,
			},
			Basis: entitlement.Basis(basis), IssuedAt: issuedAt, ExpiresAt: expiresAt,
		},
		SourceSubscriptionID: parsedSubscriptionID, SourceBillingVersion: parsedSourceVersion,
	}
	if revokedAt.Valid {
		value := revokedAt.Int64
		record.RevokedAt = &value
	}
	if leaseErr != nil || accountErr != nil || vaultErr != nil || sessionErr != nil || epochErr != nil ||
		subscriptionErr != nil || sourceVersionErr != nil || createdAt != issuedAt || !entitlement.ValidOfflineLeaseRecord(record) {
		return entitlement.OfflineLeaseRecord{}, ErrInvalidEntitlementRecord
	}
	return record, nil
}

func validProjectionCommit(
	expected *entitlement.ProjectionVersion,
	record entitlement.ProjectionRecord,
	revokeAt *int64,
) bool {
	if !entitlement.ValidProjectionRecord(record) {
		return false
	}
	if expected == nil {
		if record.Version != 1 {
			return false
		}
	} else {
		if _, err := entitlement.ParseProjectionVersion(int64(*expected)); err != nil ||
			int64(*expected) == 2_147_483_647 || record.Version != *expected+1 {
			return false
		}
	}
	if record.State.Kind == entitlement.StateLocked {
		return revokeAt != nil && *revokeAt == record.CheckedAt
	}
	return revokeAt == nil
}

func projectionBindings(record entitlement.ProjectionRecord) []any {
	return []any{
		string(record.AccountID), string(record.VaultID), int64(record.Version),
		string(record.SourceSubscriptionID), int64(record.SourceBillingVersion),
		string(record.State.Kind), stateValidUntil(record.State), stateLockReason(record.State),
		record.CheckedAt, record.CreatedAt, record.UpdatedAt,
	}
}

func stateValidUntil(state entitlement.State) any {
	if state.Kind == entitlement.StateLocked {
		return nil
	}
	return state.ValidUntil
}

func stateLockReason(state entitlement.State) any {
	if state.Kind != entitlement.StateLocked {
		return nil
	}
	return string(state.Reason)
}

func projectionAllowsLease(
	projection entitlement.ProjectionRecord,
	expected entitlement.ProjectionVersion,
	lease entitlement.OfflineLeaseRecord,
) bool {
	return projection.Version == expected && projection.AccountID == lease.Context.AccountID &&
		projection.VaultID == lease.Context.VaultID && projection.SourceSubscriptionID == lease.SourceSubscriptionID &&
		projection.SourceBillingVersion == lease.SourceBillingVersion && projection.State.Kind != entitlement.StateLocked &&
		projection.State.ValidUntil >= lease.ExpiresAt
}

func sameOfflineLease(left entitlement.OfflineLeaseRecord, right entitlement.OfflineLeaseRecord) bool {
	return left.LeaseID == right.LeaseID && left.Context == right.Context &&
		left.SourceSubscriptionID == right.SourceSubscriptionID && left.SourceBillingVersion == right.SourceBillingVersion &&
		left.Basis == right.Basis && left.IssuedAt == right.IssuedAt && left.ExpiresAt == right.ExpiresAt &&
		sameOptionalTimestamp(left.RevokedAt, right.RevokedAt)
}

func sameOptionalTimestamp(left *int64, right *int64) bool {
	return left == nil && right == nil || left != nil && right != nil && *left == *right
}

func classifyEntitlementWriteError(err error) error {
	if err == nil {
		return nil
	}
	var postgresError *pgconn.PgError
	if errors.As(err, &postgresError) {
		switch postgresError.Code {
		case "23503":
			return ErrInvalidEntitlementOperation
		case "23514", "22003":
			return ErrInvalidEntitlementRecord
		}
	}
	return err
}
