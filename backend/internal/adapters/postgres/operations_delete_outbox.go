package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/fukamu/notes/backend/internal/operations"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrInvalidDeleteOutboxScopeOperation = errors.New("invalid delete outbox scope operation")

type DeleteOutboxScopeStore struct {
	pool *pgxpool.Pool
}

func NewDeleteOutboxScopeStore(pool *pgxpool.Pool) (*DeleteOutboxScopeStore, error) {
	if pool == nil {
		return nil, ErrInvalidDeleteOutboxScopeOperation
	}
	return &DeleteOutboxScopeStore{pool: pool}, nil
}

func (store *DeleteOutboxScopeStore) OwnsDeleteOutboxScope(
	ctx context.Context,
	command operations.DeleteOutboxCommand,
) (bool, error) {
	if store == nil || store.pool == nil || ctx == nil || operations.ValidateDeleteOutboxCommand(command) != nil {
		return false, ErrInvalidDeleteOutboxScopeOperation
	}
	return ownsDeleteOutboxScope(ctx, store.pool, command.Scope)
}

type ScopedDeleteOutboxStore struct {
	pool  *pgxpool.Pool
	scope operations.DeleteOutboxScope
}

var _ encryptedobject.VaultObjectDeleteOutboxRepository = (*ScopedDeleteOutboxStore)(nil)

func NewScopedDeleteOutboxStore(
	pool *pgxpool.Pool,
	scope operations.DeleteOutboxScope,
) (*ScopedDeleteOutboxStore, error) {
	if pool == nil || !scope.Valid() {
		return nil, ErrInvalidDeleteOutboxScopeOperation
	}
	return &ScopedDeleteOutboxStore{pool: pool, scope: scope}, nil
}

func (store *ScopedDeleteOutboxStore) CountPending(ctx context.Context) (int64, error) {
	if err := store.validateOwner(ctx); err != nil {
		return 0, err
	}
	var count int64
	if err := store.pool.QueryRow(
		ctx,
		`SELECT COUNT(*)
		   FROM vault_object_delete_outbox pending
		  WHERE pending.vault_id = $1
		    AND EXISTS (
		      SELECT 1 FROM personal_vaults owner
		       WHERE owner.account_id = $2 AND owner.vault_id = pending.vault_id
		    )`,
		string(store.scope.VaultID),
		string(store.scope.AccountID),
	).Scan(&count); err != nil || count < 0 || count > identity.MaximumSafeInteger {
		return 0, errors.New("count scoped delete outbox")
	}
	if err := store.validateOwner(ctx); err != nil {
		return 0, err
	}
	return count, nil
}

func (store *ScopedDeleteOutboxStore) ListReady(
	ctx context.Context,
	attemptedAt int64,
	limit int,
) ([]encryptedobject.DeleteOutboxEntry, error) {
	if store == nil || store.pool == nil || ctx == nil || !store.scope.Valid() ||
		attemptedAt < 0 || attemptedAt > identity.MaximumSafeInteger ||
		limit < 1 || limit > encryptedobject.MaximumDeleteOutboxBatchSize {
		return nil, ErrInvalidDeleteOutboxScopeOperation
	}
	if err := store.validateOwner(ctx); err != nil {
		return nil, err
	}
	rows, err := store.pool.Query(
		ctx,
		`SELECT pending.object_key, pending.attempt_count,
		        pending.next_attempt_at, pending.created_at
		   FROM vault_object_delete_outbox pending
		  WHERE pending.vault_id = $1 AND pending.next_attempt_at <= $2
		    AND EXISTS (
		      SELECT 1 FROM personal_vaults owner
		       WHERE owner.account_id = $3 AND owner.vault_id = pending.vault_id
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM vault_encrypted_objects stored
		       WHERE stored.object_key = pending.object_key
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM vault_encrypted_write_intents intent
		       WHERE intent.object_key = pending.object_key
		    )
		  ORDER BY pending.next_attempt_at, pending.object_key
		  LIMIT $4`,
		string(store.scope.VaultID), attemptedAt, string(store.scope.AccountID), limit,
	)
	if err != nil {
		return nil, errors.New("list scoped delete outbox")
	}
	defer rows.Close()
	entries := make([]encryptedobject.DeleteOutboxEntry, 0)
	for rows.Next() {
		var rawKey string
		var entry encryptedobject.DeleteOutboxEntry
		if err := rows.Scan(&rawKey, &entry.AttemptCount, &entry.NextAttemptAt, &entry.CreatedAtMilli); err != nil {
			return nil, errors.New("decode scoped delete outbox")
		}
		objectKey, err := encryptedobject.ParseObjectKey(rawKey)
		if err != nil {
			return nil, errors.New("decode scoped delete outbox")
		}
		entry.ObjectKey = objectKey
		if !encryptedobject.ValidDeleteOutboxEntry(entry) || entry.NextAttemptAt > attemptedAt {
			return nil, errors.New("decode scoped delete outbox")
		}
		entries = append(entries, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("list scoped delete outbox")
	}
	if err := store.validateOwner(ctx); err != nil {
		return nil, err
	}
	return entries, nil
}

func (store *ScopedDeleteOutboxStore) ConfirmDelete(
	ctx context.Context,
	entry encryptedobject.DeleteOutboxEntry,
) (encryptedobject.DeleteOutboxMutationResult, error) {
	if store == nil || store.pool == nil || ctx == nil || !store.scope.Valid() ||
		!encryptedobject.ValidDeleteOutboxEntry(entry) {
		return encryptedobject.DeleteOutboxMutationResult{}, ErrInvalidDeleteOutboxScopeOperation
	}
	tag, err := store.pool.Exec(
		ctx,
		`DELETE FROM vault_object_delete_outbox pending
		  WHERE pending.vault_id = $1 AND pending.object_key = $2
		    AND pending.attempt_count = $3
		    AND EXISTS (
		      SELECT 1 FROM personal_vaults owner
		       WHERE owner.account_id = $4 AND owner.vault_id = pending.vault_id
		    )`,
		string(store.scope.VaultID), string(entry.ObjectKey), entry.AttemptCount,
		string(store.scope.AccountID),
	)
	if err != nil {
		return encryptedobject.DeleteOutboxMutationResult{}, errors.New("confirm scoped object delete")
	}
	return store.classifyMutation(ctx, entry.ObjectKey, tag.RowsAffected())
}

func (store *ScopedDeleteOutboxStore) RescheduleDelete(
	ctx context.Context,
	entry encryptedobject.DeleteOutboxEntry,
) (encryptedobject.DeleteOutboxMutationResult, error) {
	if store == nil || store.pool == nil || ctx == nil || !store.scope.Valid() ||
		!encryptedobject.ValidDeleteOutboxEntry(entry) || entry.AttemptCount < 1 {
		return encryptedobject.DeleteOutboxMutationResult{}, ErrInvalidDeleteOutboxScopeOperation
	}
	tag, err := store.pool.Exec(
		ctx,
		`UPDATE vault_object_delete_outbox pending
		    SET attempt_count = $1, next_attempt_at = $2
		  WHERE pending.vault_id = $3 AND pending.object_key = $4
		    AND pending.attempt_count = $5
		    AND EXISTS (
		      SELECT 1 FROM personal_vaults owner
		       WHERE owner.account_id = $6 AND owner.vault_id = pending.vault_id
		    )`,
		entry.AttemptCount, entry.NextAttemptAt, string(store.scope.VaultID),
		string(entry.ObjectKey), entry.AttemptCount-1, string(store.scope.AccountID),
	)
	if err != nil {
		return encryptedobject.DeleteOutboxMutationResult{}, errors.New("reschedule scoped object delete")
	}
	return store.classifyMutation(ctx, entry.ObjectKey, tag.RowsAffected())
}

func (store *ScopedDeleteOutboxStore) classifyMutation(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
	rowsAffected int64,
) (encryptedobject.DeleteOutboxMutationResult, error) {
	if rowsAffected == 1 {
		return encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationApplied}, nil
	}
	if rowsAffected != 0 {
		return encryptedobject.DeleteOutboxMutationResult{}, errors.New("classify scoped delete outbox mutation")
	}
	if err := store.validateOwner(ctx); err != nil {
		return encryptedobject.DeleteOutboxMutationResult{}, err
	}
	var attemptCount int64
	err := store.pool.QueryRow(
		ctx,
		`SELECT attempt_count FROM vault_object_delete_outbox
		  WHERE vault_id = $1 AND object_key = $2`,
		string(store.scope.VaultID), string(objectKey),
	).Scan(&attemptCount)
	if errors.Is(err, pgx.ErrNoRows) {
		return encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationReplayed}, nil
	}
	if err != nil || attemptCount < 0 || attemptCount > encryptedobject.MaximumDeleteAttempt {
		return encryptedobject.DeleteOutboxMutationResult{}, errors.New("classify scoped delete outbox mutation")
	}
	return encryptedobject.DeleteOutboxMutationResult{Kind: encryptedobject.DeleteOutboxMutationConflict}, nil
}

func (store *ScopedDeleteOutboxStore) validateOwner(ctx context.Context) error {
	if store == nil || store.pool == nil || ctx == nil || !store.scope.Valid() {
		return ErrInvalidDeleteOutboxScopeOperation
	}
	owned, err := ownsDeleteOutboxScope(ctx, store.pool, store.scope)
	if err != nil {
		return err
	}
	if !owned {
		return ErrInvalidDeleteOutboxScopeOperation
	}
	return nil
}

func ownsDeleteOutboxScope(
	ctx context.Context,
	pool *pgxpool.Pool,
	scope operations.DeleteOutboxScope,
) (bool, error) {
	if ctx == nil || pool == nil || !scope.Valid() {
		return false, ErrInvalidDeleteOutboxScopeOperation
	}
	var owned bool
	if err := pool.QueryRow(
		ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM personal_vaults WHERE account_id = $1 AND vault_id = $2
		 )`,
		string(scope.AccountID), string(scope.VaultID),
	).Scan(&owned); err != nil {
		return false, errors.New("read delete outbox owner")
	}
	return owned, nil
}
