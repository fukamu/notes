package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidDEKRotationOperation = errors.New("invalid DEK rotation database operation")
	ErrInvalidStoredDEKRotation    = errors.New("invalid stored DEK rotation operation")
)

type DEKRotationStore struct {
	pool *pgxpool.Pool
}

func NewDEKRotationStore(pool *pgxpool.Pool) (*DEKRotationStore, error) {
	if pool == nil {
		return nil, ErrInvalidDEKRotationOperation
	}
	return &DEKRotationStore{pool: pool}, nil
}

func (store *DEKRotationStore) Load(
	ctx context.Context,
	scope cryptocontent.RotationScope,
) (cryptocontent.RotationLoadResult, error) {
	if store == nil || store.pool == nil || cryptocontent.ValidateRotationScope(scope) != nil {
		return cryptocontent.RotationLoadResult{}, ErrInvalidDEKRotationOperation
	}
	var owner bool
	if err := store.pool.QueryRow(
		ctx,
		`SELECT EXISTS(
		   SELECT 1 FROM personal_vaults WHERE account_id = $1 AND vault_id = $2
		 )`,
		string(scope.AccountID), string(scope.VaultID),
	).Scan(&owner); err != nil {
		return cryptocontent.RotationLoadResult{}, errors.New("read DEK rotation owner")
	}
	if !owner {
		return cryptocontent.RotationLoadResult{Kind: cryptocontent.RotationNotFound}, nil
	}
	keyStore, _ := NewVaultDEKStore(store.pool)
	keyring, err := keyStore.FindKeyring(ctx, scope.VaultID)
	if err != nil {
		return cryptocontent.RotationLoadResult{}, err
	}
	if keyring == nil {
		return cryptocontent.RotationLoadResult{}, ErrInvalidStoredDEKRotation
	}
	operation, err := scanRotationOperation(store.pool.QueryRow(
		ctx,
		`SELECT account_id, vault_id, operation_id, revision, source_version,
		        target_version, state, kek_key_reference, wrapped_dek,
		        key_created_at, created_at, updated_at, completed_at
		   FROM vault_dek_rotation_operations
		  WHERE account_id = $1 AND vault_id = $2`,
		string(scope.AccountID), string(scope.VaultID),
	))
	if err != nil {
		return cryptocontent.RotationLoadResult{}, err
	}
	snapshot := cryptocontent.RotationSnapshot{Keyring: *keyring, Operation: operation}
	if !cryptocontent.ValidRotationSnapshot(snapshot) {
		return cryptocontent.RotationLoadResult{}, ErrInvalidStoredDEKRotation
	}
	return cryptocontent.RotationLoadResult{Kind: cryptocontent.RotationFound, Snapshot: snapshot}, nil
}

func (store *DEKRotationStore) Start(
	ctx context.Context,
	scope cryptocontent.RotationScope,
	plan cryptocontent.RotationStartPlan,
) (cryptocontent.RotationCommitResult, error) {
	if store == nil || store.pool == nil || plan.Kind != cryptocontent.RotationStartAccepted || plan.Next == nil ||
		cryptocontent.ValidateRotationOperation(*plan.Next) != nil || plan.Next.RotationScope != scope {
		return cryptocontent.RotationCommitResult{}, ErrInvalidDEKRotationOperation
	}
	next := *plan.Next
	if _, generating := next.State.(cryptocontent.RotationGenerating); !generating {
		return cryptocontent.RotationCommitResult{}, ErrInvalidDEKRotationOperation
	}
	var tag pgconn.CommandTag
	var err error
	if plan.Current == nil {
		tag, err = store.pool.Exec(
			ctx,
			`INSERT INTO vault_dek_rotation_operations(
			   account_id, vault_id, operation_id, revision, source_version,
			   target_version, state, created_at, updated_at
			 )
			 SELECT $1, $2, $3, $4, $5, $6, 'generating', $7, $8
			  WHERE EXISTS (
			    SELECT 1 FROM personal_vaults WHERE account_id = $1 AND vault_id = $2
			  )
			 ON CONFLICT DO NOTHING`,
			string(scope.AccountID), string(scope.VaultID), string(next.OperationID), int64(next.Revision),
			int64(next.SourceVersion), int64(next.TargetVersion), next.CreatedAtMilli, next.UpdatedAtMilli,
		)
	} else {
		current := *plan.Current
		if _, completed := current.State.(cryptocontent.RotationCompleted); !completed {
			return store.conflict(ctx, scope)
		}
		tag, err = store.pool.Exec(
			ctx,
			`UPDATE vault_dek_rotation_operations SET
			   operation_id = $1, revision = $2, source_version = $3,
			   target_version = $4, state = 'generating', kek_key_reference = NULL,
			   wrapped_dek = NULL, key_created_at = NULL, created_at = $5,
			   updated_at = $6, completed_at = NULL
			 WHERE account_id = $7 AND vault_id = $8 AND operation_id = $9
			   AND revision = $10 AND state = 'completed'`,
			string(next.OperationID), int64(next.Revision), int64(next.SourceVersion), int64(next.TargetVersion),
			next.CreatedAtMilli, next.UpdatedAtMilli, string(scope.AccountID), string(scope.VaultID),
			string(current.OperationID), int64(current.Revision),
		)
	}
	if err != nil {
		return cryptocontent.RotationCommitResult{}, errors.New("start DEK rotation")
	}
	return store.afterCommit(ctx, scope, next, tag.RowsAffected())
}

func (store *DEKRotationStore) RecordGenerated(
	ctx context.Context,
	scope cryptocontent.RotationScope,
	transition cryptocontent.RotationTransition,
) (cryptocontent.RotationCommitResult, error) {
	if store == nil || store.pool == nil || !cryptocontent.ValidRotationTransition(transition) ||
		transition.Current.RotationScope != scope || transition.Next.RotationScope != scope {
		return cryptocontent.RotationCommitResult{}, ErrInvalidDEKRotationOperation
	}
	if _, ok := transition.Current.State.(cryptocontent.RotationGenerating); !ok {
		return cryptocontent.RotationCommitResult{}, ErrInvalidDEKRotationOperation
	}
	nextState, ok := transition.Next.State.(cryptocontent.RotationPromoting)
	if !ok {
		return cryptocontent.RotationCommitResult{}, ErrInvalidDEKRotationOperation
	}
	tag, err := store.pool.Exec(
		ctx,
		`UPDATE vault_dek_rotation_operations SET
		   revision = $1, state = 'promoting', kek_key_reference = $2,
		   wrapped_dek = $3, key_created_at = $4, updated_at = $5
		 WHERE account_id = $6 AND vault_id = $7 AND operation_id = $8
		   AND revision = $9 AND state = 'generating'`,
		int64(transition.Next.Revision), nextState.Metadata.KEKReference, nextState.Metadata.WrappedDEK,
		nextState.Metadata.CreatedAtMilli, transition.Next.UpdatedAtMilli, string(scope.AccountID),
		string(scope.VaultID), string(transition.Current.OperationID), int64(transition.Current.Revision),
	)
	if err != nil {
		return cryptocontent.RotationCommitResult{}, errors.New("record generated DEK")
	}
	return store.afterCommit(ctx, scope, transition.Next, tag.RowsAffected())
}

func (store *DEKRotationStore) Promote(
	ctx context.Context,
	scope cryptocontent.RotationScope,
	transition cryptocontent.RotationTransition,
) (cryptocontent.RotationCommitResult, error) {
	if store == nil || store.pool == nil || !cryptocontent.ValidRotationTransition(transition) ||
		transition.Current.RotationScope != scope || transition.Next.RotationScope != scope {
		return cryptocontent.RotationCommitResult{}, ErrInvalidDEKRotationOperation
	}
	if _, ok := transition.Current.State.(cryptocontent.RotationPromoting); !ok {
		return cryptocontent.RotationCommitResult{}, ErrInvalidDEKRotationOperation
	}
	completed, ok := transition.Next.State.(cryptocontent.RotationCompleted)
	if !ok {
		return cryptocontent.RotationCommitResult{}, ErrInvalidDEKRotationOperation
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return cryptocontent.RotationCommitResult{}, errors.New("begin DEK promotion")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(ctx, `SELECT pg_advisory_xact_lock(hashtextextended($1, 7308))`, string(scope.VaultID)); err != nil {
		return cryptocontent.RotationCommitResult{}, errors.New("lock DEK promotion")
	}
	tag, err := tx.Exec(
		ctx,
		`UPDATE vault_dek_rotation_operations SET
		   revision = $1, state = 'completed', updated_at = $2, completed_at = $3
		 WHERE account_id = $4 AND vault_id = $5 AND operation_id = $6
		   AND revision = $7 AND state = 'promoting'
		   AND kek_key_reference = $8 AND wrapped_dek = $9 AND key_created_at = $10`,
		int64(transition.Next.Revision), transition.Next.UpdatedAtMilli, completed.CompletedAtMilli,
		string(scope.AccountID), string(scope.VaultID), string(transition.Current.OperationID),
		int64(transition.Current.Revision), completed.Metadata.KEKReference, completed.Metadata.WrappedDEK,
		completed.Metadata.CreatedAtMilli,
	)
	if err != nil {
		return cryptocontent.RotationCommitResult{}, errors.New("complete DEK rotation")
	}
	if tag.RowsAffected() != 1 {
		return cryptocontent.RotationCommitResult{Kind: cryptocontent.RotationConflict}, nil
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO vault_dek_versions(
		   vault_id, dek_version, kek_key_reference, wrapped_dek, is_write_key, created_at
		 ) VALUES ($1, $2, $3, $4, false, $5)
		 ON CONFLICT (vault_id, dek_version) DO NOTHING`,
		string(scope.VaultID), int64(completed.Metadata.DEKVersion), completed.Metadata.KEKReference,
		completed.Metadata.WrappedDEK, completed.Metadata.CreatedAtMilli,
	); err != nil {
		return cryptocontent.RotationCommitResult{}, errors.New("store promoted DEK")
	}
	var storedReference, storedWrapped string
	var storedCreated int64
	if err := tx.QueryRow(
		ctx,
		`SELECT kek_key_reference, wrapped_dek, created_at
		   FROM vault_dek_versions WHERE vault_id = $1 AND dek_version = $2`,
		string(scope.VaultID), int64(completed.Metadata.DEKVersion),
	).Scan(&storedReference, &storedWrapped, &storedCreated); err != nil ||
		storedReference != completed.Metadata.KEKReference || storedWrapped != completed.Metadata.WrappedDEK ||
		storedCreated != completed.Metadata.CreatedAtMilli {
		return cryptocontent.RotationCommitResult{Kind: cryptocontent.RotationConflict}, nil
	}
	sourceTag, err := tx.Exec(
		ctx,
		`UPDATE vault_dek_versions SET is_write_key = false
		 WHERE vault_id = $1 AND dek_version = $2 AND is_write_key = true`,
		string(scope.VaultID), int64(transition.Current.SourceVersion),
	)
	if err != nil || sourceTag.RowsAffected() != 1 {
		return cryptocontent.RotationCommitResult{}, errors.New("retire DEK write role")
	}
	targetTag, err := tx.Exec(
		ctx,
		`UPDATE vault_dek_versions SET is_write_key = true
		 WHERE vault_id = $1 AND dek_version = $2 AND is_write_key = false`,
		string(scope.VaultID), int64(transition.Current.TargetVersion),
	)
	if err != nil || targetTag.RowsAffected() != 1 {
		return cryptocontent.RotationCommitResult{}, errors.New("promote DEK write role")
	}
	if err := tx.Commit(ctx); err != nil {
		return cryptocontent.RotationCommitResult{}, errors.New("commit DEK promotion")
	}
	return store.afterCommit(ctx, scope, transition.Next, 1)
}

func (store *DEKRotationStore) afterCommit(
	ctx context.Context,
	scope cryptocontent.RotationScope,
	expected cryptocontent.RotationOperation,
	changes int64,
) (cryptocontent.RotationCommitResult, error) {
	loaded, err := store.Load(ctx, scope)
	if err != nil {
		return cryptocontent.RotationCommitResult{}, err
	}
	if loaded.Kind == cryptocontent.RotationFound && loaded.Snapshot.Operation != nil &&
		cryptocontent.SameRotationOperation(*loaded.Snapshot.Operation, expected) {
		snapshot := loaded.Snapshot
		kind := cryptocontent.RotationReplayed
		if changes == 1 {
			kind = cryptocontent.RotationApplied
		}
		return cryptocontent.RotationCommitResult{Kind: kind, Snapshot: &snapshot}, nil
	}
	return cryptocontent.RotationCommitResult{Kind: cryptocontent.RotationConflict}, nil
}

func (store *DEKRotationStore) conflict(
	ctx context.Context,
	scope cryptocontent.RotationScope,
) (cryptocontent.RotationCommitResult, error) {
	loaded, err := store.Load(ctx, scope)
	if err != nil {
		return cryptocontent.RotationCommitResult{}, err
	}
	if loaded.Kind == cryptocontent.RotationFound {
		snapshot := loaded.Snapshot
		return cryptocontent.RotationCommitResult{Kind: cryptocontent.RotationConflict, Snapshot: &snapshot}, nil
	}
	return cryptocontent.RotationCommitResult{Kind: cryptocontent.RotationConflict}, nil
}

type rotationRowScanner interface {
	Scan(...any) error
}

func scanRotationOperation(row rotationRowScanner) (*cryptocontent.RotationOperation, error) {
	var rawAccountID, rawVaultID, rawOperationID, rawState string
	var revision, sourceVersion, targetVersion, createdAt, updatedAt int64
	var keyReference, wrappedDEK *string
	var keyCreatedAt, completedAt *int64
	err := row.Scan(
		&rawAccountID, &rawVaultID, &rawOperationID, &revision, &sourceVersion, &targetVersion,
		&rawState, &keyReference, &wrappedDEK, &keyCreatedAt, &createdAt, &updatedAt, &completedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("read DEK rotation")
	}
	accountID, accountErr := identity.ParseAccountID(rawAccountID)
	vaultID, vaultErr := identity.ParseVaultID(rawVaultID)
	operationID, operationErr := cryptocontent.ParseRotationOperationID(rawOperationID)
	source, sourceErr := cryptocontent.ParseDEKVersion(sourceVersion)
	target, targetErr := cryptocontent.ParseDEKVersion(targetVersion)
	operation := cryptocontent.RotationOperation{
		RotationScope: cryptocontent.RotationScope{AccountID: accountID, VaultID: vaultID}, OperationID: operationID,
		Revision: cryptocontent.RotationRevision(revision), SourceVersion: source, TargetVersion: target,
		CreatedAtMilli: createdAt, UpdatedAtMilli: updatedAt,
	}
	if accountErr != nil || vaultErr != nil || operationErr != nil || sourceErr != nil || targetErr != nil {
		return nil, ErrInvalidStoredDEKRotation
	}
	switch rawState {
	case "generating":
		if keyReference != nil || wrappedDEK != nil || keyCreatedAt != nil || completedAt != nil {
			return nil, ErrInvalidStoredDEKRotation
		}
		operation.State = cryptocontent.RotationGenerating{}
	case "promoting", "completed":
		if keyReference == nil || wrappedDEK == nil || keyCreatedAt == nil {
			return nil, ErrInvalidStoredDEKRotation
		}
		metadata := cryptocontent.VaultDEKMetadata{
			VaultID: vaultID, DEKVersion: target, KEKReference: *keyReference,
			WrappedDEK: *wrappedDEK, CreatedAtMilli: *keyCreatedAt,
		}
		if rawState == "promoting" {
			if completedAt != nil {
				return nil, ErrInvalidStoredDEKRotation
			}
			operation.State = cryptocontent.RotationPromoting{Metadata: metadata}
		} else {
			if completedAt == nil {
				return nil, ErrInvalidStoredDEKRotation
			}
			operation.State = cryptocontent.RotationCompleted{Metadata: metadata, CompletedAtMilli: *completedAt}
		}
	default:
		return nil, ErrInvalidStoredDEKRotation
	}
	if cryptocontent.ValidateRotationOperation(operation) != nil {
		return nil, ErrInvalidStoredDEKRotation
	}
	return &operation, nil
}
