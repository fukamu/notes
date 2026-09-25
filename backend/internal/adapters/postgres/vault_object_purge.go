package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidVaultObjectPurgeOperation = errors.New("invalid Vault private-object purge operation")

type VaultObjectDeleteOutboxDirectory struct {
	pool *pgxpool.Pool
}

var _ encryptedobject.VaultObjectDeleteOutboxDirectory = (*VaultObjectDeleteOutboxDirectory)(nil)

func NewVaultObjectDeleteOutboxDirectory(pool *pgxpool.Pool) (*VaultObjectDeleteOutboxDirectory, error) {
	if pool == nil {
		return nil, ErrInvalidVaultObjectPurgeOperation
	}
	return &VaultObjectDeleteOutboxDirectory{pool: pool}, nil
}

func (directory *VaultObjectDeleteOutboxDirectory) Open(
	ctx context.Context,
	command encryptedobject.VaultPrivateObjectPurgeCommand,
) (encryptedobject.DeleteOutboxOpenResult, error) {
	if directory == nil || directory.pool == nil || !encryptedobject.ValidVaultPrivateObjectPurgeCommand(command) {
		return encryptedobject.DeleteOutboxOpenResult{}, ErrInvalidVaultObjectPurgeOperation
	}
	ownerPresent, authorized, err := vaultObjectPurgeState(ctx, directory.pool, command)
	if err != nil {
		return encryptedobject.DeleteOutboxOpenResult{}, err
	}
	if !ownerPresent {
		return encryptedobject.DeleteOutboxOpenResult{Kind: encryptedobject.DeleteOutboxOwnerMismatch}, nil
	}
	if !authorized {
		return encryptedobject.DeleteOutboxOpenResult{Kind: encryptedobject.DeleteOutboxIntegrityFailure}, nil
	}
	return encryptedobject.DeleteOutboxOpenResult{
		Kind: encryptedobject.DeleteOutboxOpened,
		Repository: &vaultObjectDeleteOutboxRepository{
			pool: directory.pool, command: command,
		},
	}, nil
}

type vaultObjectDeleteOutboxRepository struct {
	pool    *pgxpool.Pool
	command encryptedobject.VaultPrivateObjectPurgeCommand
}

var _ encryptedobject.VaultObjectDeleteOutboxRepository = (*vaultObjectDeleteOutboxRepository)(nil)

func (repository *vaultObjectDeleteOutboxRepository) CountPending(ctx context.Context) (int64, error) {
	if repository.invalid() {
		return 0, ErrInvalidVaultObjectPurgeOperation
	}
	ownerPresent, authorized, err := vaultObjectPurgeState(ctx, repository.pool, repository.command)
	if err != nil {
		return 0, err
	}
	if !ownerPresent || !authorized {
		return 0, ErrInvalidVaultObjectPurgeOperation
	}
	var count int64
	err = repository.pool.QueryRow(ctx, `SELECT COUNT(*) FROM vault_object_delete_outbox
		WHERE vault_id = $1`, string(repository.command.Scope.VaultID)).Scan(&count)
	if err != nil || count < 0 || count > identity.MaximumSafeInteger {
		return 0, errors.New("count Vault object delete outbox")
	}
	return count, nil
}

func (repository *vaultObjectDeleteOutboxRepository) ListReady(
	ctx context.Context,
	now int64,
	limit int,
) ([]encryptedobject.DeleteOutboxEntry, error) {
	if repository.invalid() || now < 0 || now > identity.MaximumSafeInteger || limit < 1 || limit > 100 {
		return nil, ErrInvalidVaultObjectPurgeOperation
	}
	ownerPresent, authorized, err := vaultObjectPurgeState(ctx, repository.pool, repository.command)
	if err != nil {
		return nil, err
	}
	if !ownerPresent || !authorized {
		return nil, ErrInvalidVaultObjectPurgeOperation
	}
	rows, err := repository.pool.Query(ctx, `SELECT object_key, attempt_count, next_attempt_at, created_at
		FROM vault_object_delete_outbox
		WHERE vault_id = $1 AND next_attempt_at <= $2
		ORDER BY next_attempt_at, object_key LIMIT $3`,
		string(repository.command.Scope.VaultID), now, limit)
	if err != nil {
		return nil, errors.New("list Vault object delete outbox")
	}
	defer rows.Close()
	entries := make([]encryptedobject.DeleteOutboxEntry, 0)
	for rows.Next() {
		var rawKey string
		var entry encryptedobject.DeleteOutboxEntry
		if err := rows.Scan(&rawKey, &entry.AttemptCount, &entry.NextAttemptAt, &entry.CreatedAtMilli); err != nil {
			return nil, errors.New("decode Vault object delete outbox")
		}
		objectKey, err := encryptedobject.ParseObjectKey(rawKey)
		if err != nil {
			return nil, errors.New("decode Vault object delete outbox")
		}
		entry.ObjectKey = objectKey
		if !encryptedobject.ValidDeleteOutboxEntry(entry) {
			return nil, errors.New("decode Vault object delete outbox")
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("list Vault object delete outbox")
	}
	return entries, nil
}

func (repository *vaultObjectDeleteOutboxRepository) ConfirmDelete(
	ctx context.Context,
	entry encryptedobject.DeleteOutboxEntry,
) (encryptedobject.DeleteOutboxMutationResult, error) {
	if repository.invalid() || !encryptedobject.ValidDeleteOutboxEntry(entry) {
		return encryptedobject.DeleteOutboxMutationResult{}, ErrInvalidVaultObjectPurgeOperation
	}
	tag, err := repository.pool.Exec(ctx, `DELETE FROM vault_object_delete_outbox pending
		WHERE pending.vault_id = $1 AND pending.object_key = $2 AND pending.attempt_count = $3
		  AND EXISTS (
		    SELECT 1 FROM personal_vaults owner
		    WHERE owner.account_id = $4 AND owner.vault_id = pending.vault_id
		  )
		  AND EXISTS (
		    SELECT 1 FROM account_deletion_operations operation
		    JOIN account_deletion_step_receipts receipt ON receipt.operation_id = operation.operation_id
		    WHERE operation.operation_id = $5 AND operation.account_id = $4
		      AND operation.vault_id = pending.vault_id AND operation.state = 'running'
		      AND operation.current_step = 'delete-private-objects'
		      AND receipt.step = 'delete-vault-data' AND receipt.completed_at = $6
		  )`, string(repository.command.Scope.VaultID), string(entry.ObjectKey), entry.AttemptCount,
		string(repository.command.Scope.AccountID), string(repository.command.OperationID),
		repository.command.PreviousReceiptAt)
	if err != nil {
		return encryptedobject.DeleteOutboxMutationResult{}, errors.New("confirm Vault private-object delete")
	}
	return repository.classifyMutation(ctx, entry.ObjectKey, tag.RowsAffected())
}

func (repository *vaultObjectDeleteOutboxRepository) RescheduleDelete(
	ctx context.Context,
	entry encryptedobject.DeleteOutboxEntry,
) (encryptedobject.DeleteOutboxMutationResult, error) {
	if repository.invalid() || !encryptedobject.ValidDeleteOutboxEntry(entry) || entry.AttemptCount < 1 {
		return encryptedobject.DeleteOutboxMutationResult{}, ErrInvalidVaultObjectPurgeOperation
	}
	tag, err := repository.pool.Exec(ctx, `UPDATE vault_object_delete_outbox pending
		SET attempt_count = $1, next_attempt_at = $2
		WHERE pending.vault_id = $3 AND pending.object_key = $4 AND pending.attempt_count = $5
		  AND EXISTS (
		    SELECT 1 FROM personal_vaults owner
		    WHERE owner.account_id = $6 AND owner.vault_id = pending.vault_id
		  )
		  AND EXISTS (
		    SELECT 1 FROM account_deletion_operations operation
		    JOIN account_deletion_step_receipts receipt ON receipt.operation_id = operation.operation_id
		    WHERE operation.operation_id = $7 AND operation.account_id = $6
		      AND operation.vault_id = pending.vault_id AND operation.state = 'running'
		      AND operation.current_step = 'delete-private-objects'
		      AND receipt.step = 'delete-vault-data' AND receipt.completed_at = $8
		  )`, entry.AttemptCount, entry.NextAttemptAt, string(repository.command.Scope.VaultID),
		string(entry.ObjectKey), entry.AttemptCount-1, string(repository.command.Scope.AccountID),
		string(repository.command.OperationID), repository.command.PreviousReceiptAt)
	if err != nil {
		return encryptedobject.DeleteOutboxMutationResult{}, errors.New("reschedule Vault private-object delete")
	}
	return repository.classifyMutation(ctx, entry.ObjectKey, tag.RowsAffected())
}

func (repository *vaultObjectDeleteOutboxRepository) classifyMutation(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
	rowsAffected int64,
) (encryptedobject.DeleteOutboxMutationResult, error) {
	if rowsAffected == 1 {
		return encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationApplied}, nil
	}
	if rowsAffected != 0 {
		return encryptedobject.DeleteOutboxMutationResult{}, errors.New("classify Vault object delete mutation")
	}
	ownerPresent, authorized, err := vaultObjectPurgeState(ctx, repository.pool, repository.command)
	if err != nil || !ownerPresent || !authorized {
		return encryptedobject.DeleteOutboxMutationResult{}, ErrInvalidVaultObjectPurgeOperation
	}
	var found bool
	err = repository.pool.QueryRow(ctx, `SELECT EXISTS (
		SELECT 1 FROM vault_object_delete_outbox WHERE vault_id = $1 AND object_key = $2
	)`, string(repository.command.Scope.VaultID), string(objectKey)).Scan(&found)
	if err != nil {
		return encryptedobject.DeleteOutboxMutationResult{}, errors.New("classify Vault object delete mutation")
	}
	if !found {
		return encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationReplayed}, nil
	}
	return encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationConflict}, nil
}

func (repository *vaultObjectDeleteOutboxRepository) invalid() bool {
	return repository == nil || repository.pool == nil ||
		!encryptedobject.ValidVaultPrivateObjectPurgeCommand(repository.command)
}

type vaultObjectPurgeStateQuerier interface {
	QueryRow(context.Context, string, ...any) pgx.Row
}

func vaultObjectPurgeState(
	ctx context.Context,
	query vaultObjectPurgeStateQuerier,
	command encryptedobject.VaultPrivateObjectPurgeCommand,
) (ownerPresent, authorized bool, err error) {
	err = query.QueryRow(ctx, `SELECT
		EXISTS (
		  SELECT 1 FROM personal_vaults
		  WHERE account_id = $1 AND vault_id = $2
		),
		EXISTS (
		  SELECT 1 FROM account_deletion_operations operation
		  JOIN account_deletion_step_receipts receipt ON receipt.operation_id = operation.operation_id
		  WHERE operation.operation_id = $3 AND operation.account_id = $1 AND operation.vault_id = $2
		    AND operation.state = 'running' AND operation.current_step = 'delete-private-objects'
		    AND receipt.step = 'delete-vault-data' AND receipt.completed_at = $4
		)`, string(command.Scope.AccountID), string(command.Scope.VaultID),
		string(command.OperationID), command.PreviousReceiptAt).Scan(&ownerPresent, &authorized)
	if err != nil {
		return false, false, errors.New("verify Vault private-object purge authorization")
	}
	return ownerPresent, authorized, nil
}
