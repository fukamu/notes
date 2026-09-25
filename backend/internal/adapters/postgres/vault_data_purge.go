package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/vaultdata"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidVaultDataPurgeOperation = errors.New("invalid Vault data purge operation")

type VaultDataPurgeStore struct {
	pool *pgxpool.Pool
}

var _ vaultdata.Repository = (*VaultDataPurgeStore)(nil)

func NewVaultDataPurgeStore(pool *pgxpool.Pool) (*VaultDataPurgeStore, error) {
	if pool == nil {
		return nil, ErrInvalidVaultDataPurgeOperation
	}
	return &VaultDataPurgeStore{pool: pool}, nil
}

func (store *VaultDataPurgeStore) PurgeVaultData(
	ctx context.Context,
	command vaultdata.PurgeCommand,
) (vaultdata.RepositoryResult, error) {
	if store == nil || store.pool == nil || !vaultdata.ValidCommand(command) {
		return vaultdata.RepositoryResult{}, ErrInvalidVaultDataPurgeOperation
	}
	tx, err := store.pool.BeginTx(ctx, pgx.TxOptions{IsoLevel: pgx.Serializable})
	if err != nil {
		return vaultdata.RepositoryResult{}, errors.New("begin Vault data purge")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()

	var owner int
	err = tx.QueryRow(ctx, `SELECT 1 FROM personal_vaults
		WHERE account_id = $1 AND vault_id = $2 FOR UPDATE`,
		string(command.Scope.AccountID), string(command.Scope.VaultID),
	).Scan(&owner)
	if errors.Is(err, pgx.ErrNoRows) {
		return vaultdata.RepositoryResult{Kind: vaultdata.RepositoryOwnerMismatch}, nil
	}
	if err != nil {
		return vaultdata.RepositoryResult{}, errors.New("lock Vault data purge owner")
	}

	before, err := countVaultLiveRows(ctx, tx, string(command.Scope.AccountID), string(command.Scope.VaultID))
	if err != nil {
		return vaultdata.RepositoryResult{}, err
	}
	var authorized bool
	err = tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1
		  FROM account_deletion_operations operation
		  JOIN account_deletion_step_receipts receipt
		    ON receipt.operation_id = operation.operation_id
		 WHERE operation.operation_id = $1
		   AND operation.account_id = $2 AND operation.vault_id = $3
		   AND operation.state = 'running' AND operation.current_step = 'delete-vault-data'
		   AND receipt.step = 'cancel-subscription' AND receipt.completed_at = $4
	)`, string(command.OperationID), string(command.Scope.AccountID),
		string(command.Scope.VaultID), command.RequestedAt,
	).Scan(&authorized)
	if err != nil {
		return vaultdata.RepositoryResult{}, errors.New("verify Vault data purge authorization")
	}
	if !authorized {
		return vaultdata.RepositoryResult{
			Kind: vaultdata.RepositoryIntegrityFailure, LiveRowsBefore: before,
		}, nil
	}
	var crossVaultCollision bool
	err = tx.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1
		  FROM (
		    SELECT object_key FROM vault_encrypted_objects WHERE vault_id = $1
		    UNION
		    SELECT object_key FROM vault_encrypted_write_intents WHERE vault_id = $1
		  ) source
		  JOIN vault_object_delete_outbox pending USING (object_key)
		 WHERE pending.vault_id <> $1
	)`, string(command.Scope.VaultID)).Scan(&crossVaultCollision)
	if err != nil {
		return vaultdata.RepositoryResult{}, errors.New("inspect Vault object delete ownership")
	}
	if crossVaultCollision {
		return vaultdata.RepositoryResult{
			Kind: vaultdata.RepositoryIntegrityFailure, LiveRowsBefore: before,
		}, nil
	}

	tag, err := tx.Exec(ctx, `INSERT INTO vault_object_delete_outbox(
		vault_id, object_key, attempt_count, next_attempt_at, created_at
	)
	SELECT $1, source.object_key, 0, $2, $2
	  FROM (
	    SELECT object_key FROM vault_encrypted_objects WHERE vault_id = $1
	    UNION
	    SELECT object_key FROM vault_encrypted_write_intents WHERE vault_id = $1
	  ) source
	ON CONFLICT (object_key) DO NOTHING`, string(command.Scope.VaultID), command.RequestedAt)
	if err != nil {
		return vaultdata.RepositoryResult{}, errors.New("enqueue Vault object deletes")
	}
	enqueued := tag.RowsAffected()

	if _, err := tx.Exec(ctx, `DELETE FROM vault_encrypted_objects stored
		WHERE stored.vault_id = $1 AND EXISTS (
		  SELECT 1 FROM vault_object_delete_outbox pending
		   WHERE pending.vault_id = stored.vault_id AND pending.object_key = stored.object_key
		)`, string(command.Scope.VaultID)); err != nil {
		return vaultdata.RepositoryResult{}, errors.New("delete Vault encrypted object metadata")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM vault_encrypted_write_intents intent
		WHERE intent.vault_id = $1 AND EXISTS (
		  SELECT 1 FROM vault_object_delete_outbox pending
		   WHERE pending.vault_id = intent.vault_id AND pending.object_key = intent.object_key
		)`, string(command.Scope.VaultID)); err != nil {
		return vaultdata.RepositoryResult{}, errors.New("delete Vault encrypted write intents")
	}

	var sourceRows int64
	err = tx.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM vault_encrypted_objects WHERE vault_id = $1) +
		(SELECT COUNT(*) FROM vault_encrypted_write_intents WHERE vault_id = $1)`,
		string(command.Scope.VaultID),
	).Scan(&sourceRows)
	if err != nil {
		return vaultdata.RepositoryResult{}, errors.New("verify Vault encrypted inventory purge")
	}
	if sourceRows != 0 {
		return vaultdata.RepositoryResult{
			Kind: vaultdata.RepositoryIntegrityFailure, LiveRowsBefore: before,
		}, nil
	}

	if _, err := tx.Exec(ctx, `DELETE FROM vault_sync_v2_commits
		WHERE account_id = $1 AND vault_id = $2`,
		string(command.Scope.AccountID), string(command.Scope.VaultID)); err != nil {
		return vaultdata.RepositoryResult{}, errors.New("delete Vault sync commits")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM vault_sync_v2_states
		WHERE account_id = $1 AND vault_id = $2`,
		string(command.Scope.AccountID), string(command.Scope.VaultID)); err != nil {
		return vaultdata.RepositoryResult{}, errors.New("delete Vault sync live data")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM vault_quota_finalization_assertions
		WHERE account_id = $1 AND vault_id = $2`,
		string(command.Scope.AccountID), string(command.Scope.VaultID)); err != nil {
		return vaultdata.RepositoryResult{}, errors.New("delete Vault quota assertions")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM vault_quota_reservations
		WHERE account_id = $1 AND vault_id = $2`,
		string(command.Scope.AccountID), string(command.Scope.VaultID)); err != nil {
		return vaultdata.RepositoryResult{}, errors.New("delete Vault quota reservations")
	}
	if _, err := tx.Exec(ctx, `DELETE FROM vault_quota_usage
		WHERE account_id = $1 AND vault_id = $2`,
		string(command.Scope.AccountID), string(command.Scope.VaultID)); err != nil {
		return vaultdata.RepositoryResult{}, errors.New("delete Vault quota usage")
	}

	after, err := countVaultLiveRows(ctx, tx, string(command.Scope.AccountID), string(command.Scope.VaultID))
	if err != nil {
		return vaultdata.RepositoryResult{}, err
	}
	if after != 0 {
		return vaultdata.RepositoryResult{
			Kind: vaultdata.RepositoryIncomplete, LiveRowsBefore: before,
		}, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return vaultdata.RepositoryResult{}, errors.New("commit Vault data purge")
	}
	if before == 0 {
		return vaultdata.RepositoryResult{Kind: vaultdata.RepositoryAlreadyPurged}, nil
	}
	return vaultdata.RepositoryResult{
		Kind: vaultdata.RepositoryPurged, LiveRowsBefore: before, EnqueuedObjectKeys: enqueued,
	}, nil
}

type vaultDataRowQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func countVaultLiveRows(ctx context.Context, query vaultDataRowQuerier, accountID, vaultID string) (int64, error) {
	var count int64
	err := query.QueryRow(ctx, `SELECT
		(SELECT COUNT(*) FROM vault_encrypted_objects WHERE vault_id = $2) +
		(SELECT COUNT(*) FROM vault_encrypted_write_intents WHERE vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_states WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_cards WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_conflicts WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_commits WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_sync_v2_changes WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_quota_usage WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_quota_reservations WHERE account_id = $1 AND vault_id = $2) +
		(SELECT COUNT(*) FROM vault_quota_finalization_assertions WHERE account_id = $1 AND vault_id = $2)`,
		accountID, vaultID,
	).Scan(&count)
	if err != nil {
		return 0, errors.New("count Vault live data")
	}
	return count, nil
}
