package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
)

func (store *EncryptedObjectStore) LoadOrStartJob(
	ctx context.Context,
	targetVersion cryptocontent.DEKVersion,
	requestedAtMilli int64,
) (encryptedobject.ReencryptionJob, error) {
	if store.invalid() || !validDEKVersion(targetVersion) || !validDatabaseTimestamp(requestedAtMilli) {
		return encryptedobject.ReencryptionJob{}, ErrInvalidEncryptedObjectOperation
	}
	_, err := store.pool.Exec(
		ctx,
		`INSERT INTO vault_reencryption_jobs(
		   vault_id, target_version, state, revision, created_at, updated_at
		 )
		 SELECT $1, $2, 'running', 1, $3, $3
		  WHERE EXISTS (
		    SELECT 1 FROM vault_dek_versions
		     WHERE vault_id = $1 AND dek_version = $2 AND is_write_key = true
		  )
		 ON CONFLICT (vault_id) DO UPDATE SET
		   target_version = EXCLUDED.target_version,
		   after_object_type = NULL, after_object_id = NULL, after_object_revision = NULL,
		   state = 'running', revision = vault_reencryption_jobs.revision + 1,
		   created_at = EXCLUDED.created_at, updated_at = EXCLUDED.updated_at
		 WHERE vault_reencryption_jobs.state = 'completed'
		   AND vault_reencryption_jobs.target_version < EXCLUDED.target_version
		   AND vault_reencryption_jobs.revision < 2147483647`,
		string(store.vaultID), int64(targetVersion), requestedAtMilli,
	)
	if err != nil {
		return encryptedobject.ReencryptionJob{}, errors.New("start encrypted object re-encryption")
	}
	job, err := store.loadReencryptionJob(ctx)
	if err != nil {
		return encryptedobject.ReencryptionJob{}, err
	}
	if job == nil {
		return encryptedobject.ReencryptionJob{}, ErrInvalidEncryptedObjectOperation
	}
	return *job, nil
}

func (store *EncryptedObjectStore) Inventory(
	ctx context.Context,
	targetVersion cryptocontent.DEKVersion,
) (encryptedobject.ReencryptionInventory, error) {
	if store.invalid() || !validDEKVersion(targetVersion) {
		return encryptedobject.ReencryptionInventory{}, ErrInvalidEncryptedObjectOperation
	}
	var inventory encryptedobject.ReencryptionInventory
	err := store.pool.QueryRow(
		ctx,
		`SELECT
		   EXISTS(SELECT 1 FROM personal_vaults WHERE vault_id = $1),
		   (SELECT COUNT(*) FROM vault_encrypted_objects WHERE vault_id = $1 AND dek_version < $2),
		   (SELECT COUNT(*) FROM vault_encrypted_objects WHERE vault_id = $1 AND dek_version = $2),
		   (SELECT COUNT(*) FROM vault_encrypted_objects WHERE vault_id = $1 AND dek_version > $2),
		   (SELECT COUNT(*) FROM vault_encrypted_write_intents WHERE vault_id = $1 AND dek_version < $2),
		   (SELECT COUNT(*) FROM vault_encrypted_write_intents WHERE vault_id = $1 AND dek_version > $2)`,
		string(store.vaultID), int64(targetVersion),
	).Scan(
		&inventory.OwnerPresent, &inventory.OlderObjects, &inventory.TargetObjects,
		&inventory.NewerObjects, &inventory.OlderWriteIntents, &inventory.NewerWriteIntents,
	)
	if err != nil {
		return encryptedobject.ReencryptionInventory{}, errors.New("read encrypted object re-encryption inventory")
	}
	if encryptedobject.EvaluateReencryptionInventory(inventory).Reason == encryptedobject.ReencryptionBadInventory {
		return encryptedobject.ReencryptionInventory{}, ErrInvalidStoredEncryptedObject
	}
	return inventory, nil
}

func (store *EncryptedObjectStore) ListCandidates(
	ctx context.Context,
	targetVersion cryptocontent.DEKVersion,
	after *encryptedobject.ReencryptionPosition,
	limit int,
) ([]encryptedobject.Metadata, error) {
	if store.invalid() || !validDEKVersion(targetVersion) || limit < 1 ||
		limit > encryptedobject.MaximumReencryptionBatchSize || !validReencryptionPosition(after) {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	query := `SELECT object_type, object_id, object_revision, write_id, object_key,
	                 plaintext_bytes, ciphertext_bytes, crypto_version, dek_version, created_at
	            FROM vault_encrypted_objects
	           WHERE vault_id = $1 AND dek_version < $2`
	arguments := []any{string(store.vaultID), int64(targetVersion)}
	if after != nil {
		query += ` AND (object_type, object_id, object_revision) > ($3, $4, $5)
		           ORDER BY object_type, object_id, object_revision LIMIT $6`
		arguments = append(
			arguments, string(after.Object.Kind), after.Object.ObjectID, int64(after.ObjectRevision), limit,
		)
	} else {
		query += ` ORDER BY object_type, object_id, object_revision LIMIT $3`
		arguments = append(arguments, limit)
	}
	rows, err := store.pool.Query(ctx, query, arguments...)
	if err != nil {
		return nil, errors.New("list encrypted object re-encryption candidates")
	}
	defer rows.Close()
	result := make([]encryptedobject.Metadata, 0, limit)
	for rows.Next() {
		metadata, scanErr := scanEncryptedObjectMetadata(rows)
		if scanErr != nil || metadata == nil {
			return nil, ErrInvalidStoredEncryptedObject
		}
		result = append(result, *metadata)
	}
	if rows.Err() != nil {
		return nil, errors.New("list encrypted object re-encryption candidates")
	}
	return result, nil
}

func (store *EncryptedObjectStore) CommitReplacement(
	ctx context.Context,
	expected encryptedobject.Metadata,
	replacement encryptedobject.Metadata,
	expectedJob encryptedobject.ReencryptionJob,
	nextJob encryptedobject.ReencryptionJob,
	requestedAtMilli int64,
) (encryptedobject.ReencryptionCommitResult, error) {
	if store.invalid() || encryptedobject.ValidateMetadata(expected) != nil ||
		encryptedobject.ValidateMetadata(replacement) != nil ||
		!encryptedobject.ValidReencryptionJobTransition(expectedJob, nextJob) ||
		!validDatabaseTimestamp(requestedAtMilli) {
		return encryptedobject.ReencryptionCommitResult{}, ErrInvalidEncryptedObjectOperation
	}
	plan := encryptedobject.PlanReencryptionCandidate(
		expected, replacement.DEKVersion, replacement.ObjectKey, replacement.CiphertextBytes,
	)
	position := encryptedobject.PositionFor(expected)
	if !plan.Accepted || !encryptedobject.SameMetadata(plan.Replacement, replacement) ||
		expectedJob.TargetVersion != replacement.DEKVersion || nextJob.TargetVersion != replacement.DEKVersion ||
		nextJob.Revision != expectedJob.Revision+1 || nextJob.After == nil ||
		encryptedobject.CompareReencryptionPosition(*nextJob.After, position) != 0 {
		return encryptedobject.ReencryptionCommitResult{}, ErrInvalidEncryptedObjectOperation
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return encryptedobject.ReencryptionCommitResult{}, errors.New("begin encrypted object re-encryption commit")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	metadataTag, err := tx.Exec(
		ctx,
		`UPDATE vault_encrypted_objects SET
		   object_key = $1, ciphertext_bytes = $2, dek_version = $3
		 WHERE vault_id = $4 AND object_type = $5 AND object_id = $6 AND object_revision = $7
		   AND write_id = $8 AND object_key = $9 AND plaintext_bytes = $10
		   AND ciphertext_bytes = $11 AND crypto_version = $12 AND dek_version = $13 AND created_at = $14`,
		string(replacement.ObjectKey), replacement.CiphertextBytes, int64(replacement.DEKVersion),
		string(store.vaultID), string(expected.Object.Kind), expected.Object.ObjectID, int64(expected.ObjectRevision),
		string(expected.WriteID), string(expected.ObjectKey), expected.PlaintextBytes, expected.CiphertextBytes,
		expected.CryptoVersion, int64(expected.DEKVersion), expected.CreatedAtMilli,
	)
	if err != nil {
		return encryptedobject.ReencryptionCommitResult{}, errors.New("update re-encrypted object metadata")
	}
	if metadataTag.RowsAffected() != 1 {
		return encryptedobject.ReencryptionCommitResult{Kind: encryptedobject.ReencryptionConflict}, nil
	}
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO vault_object_delete_outbox(
		   vault_id, object_key, attempt_count, next_attempt_at, created_at
		 ) VALUES ($1, $2, 0, $3, $3)
		 ON CONFLICT (object_key) DO NOTHING`,
		string(store.vaultID), string(expected.ObjectKey), requestedAtMilli,
	); err != nil {
		return encryptedobject.ReencryptionCommitResult{}, errors.New("enqueue old encrypted object")
	}
	var outboxVault string
	if err := tx.QueryRow(
		ctx,
		`SELECT vault_id FROM vault_object_delete_outbox WHERE object_key = $1`,
		string(expected.ObjectKey),
	).Scan(&outboxVault); err != nil || outboxVault != string(store.vaultID) {
		return encryptedobject.ReencryptionCommitResult{}, errors.New("verify old encrypted object outbox")
	}
	jobTag, err := updateReencryptionJob(ctx, tx, store.vaultID, expectedJob, nextJob)
	if err != nil {
		return encryptedobject.ReencryptionCommitResult{}, err
	}
	if jobTag.RowsAffected() != 1 {
		return encryptedobject.ReencryptionCommitResult{Kind: encryptedobject.ReencryptionConflict}, nil
	}
	if err := tx.Commit(ctx); err != nil {
		return encryptedobject.ReencryptionCommitResult{}, errors.New("commit encrypted object re-encryption")
	}
	copyOfJob := nextJob
	copyOfJob.After = copyReencryptionPosition(nextJob.After)
	return encryptedobject.ReencryptionCommitResult{Kind: encryptedobject.ReencryptionApplied, Job: &copyOfJob}, nil
}

func (store *EncryptedObjectStore) UpdateJob(
	ctx context.Context,
	expected encryptedobject.ReencryptionJob,
	next encryptedobject.ReencryptionJob,
) (encryptedobject.ReencryptionCommitResult, error) {
	if store.invalid() || !encryptedobject.ValidReencryptionJobTransition(expected, next) {
		return encryptedobject.ReencryptionCommitResult{}, ErrInvalidEncryptedObjectOperation
	}
	tag, err := updateReencryptionJob(ctx, store.pool, store.vaultID, expected, next)
	if err != nil {
		return encryptedobject.ReencryptionCommitResult{}, err
	}
	current, err := store.loadReencryptionJob(ctx)
	if err != nil {
		return encryptedobject.ReencryptionCommitResult{}, err
	}
	if current != nil && sameReencryptionJob(*current, next) {
		kind := encryptedobject.ReencryptionReplayed
		if tag.RowsAffected() == 1 {
			kind = encryptedobject.ReencryptionApplied
		}
		return encryptedobject.ReencryptionCommitResult{Kind: kind, Job: current}, nil
	}
	return encryptedobject.ReencryptionCommitResult{Kind: encryptedobject.ReencryptionConflict, Job: current}, nil
}

type reencryptionExecer interface {
	Exec(context.Context, string, ...any) (pgconn.CommandTag, error)
}

func updateReencryptionJob(
	ctx context.Context,
	execer reencryptionExecer,
	vaultID identity.VaultID,
	expected encryptedobject.ReencryptionJob,
	next encryptedobject.ReencryptionJob,
) (pgconn.CommandTag, error) {
	tag, err := execer.Exec(
		ctx,
		`UPDATE vault_reencryption_jobs SET
		   after_object_type = $1, after_object_id = $2, after_object_revision = $3,
		   state = $4, revision = $5, updated_at = $6
		 WHERE vault_id = $7 AND target_version = $8 AND state = $9 AND revision = $10
		   AND after_object_type IS NOT DISTINCT FROM $11
		   AND after_object_id IS NOT DISTINCT FROM $12
		   AND after_object_revision IS NOT DISTINCT FROM $13`,
		nullablePositionKind(next.After), nullablePositionID(next.After), nullablePositionRevision(next.After),
		string(next.State), next.Revision, next.UpdatedAtMilli, string(vaultID), int64(expected.TargetVersion),
		string(expected.State), expected.Revision, nullablePositionKind(expected.After),
		nullablePositionID(expected.After), nullablePositionRevision(expected.After),
	)
	if err != nil {
		return pgconn.CommandTag{}, errors.New("update encrypted object re-encryption checkpoint")
	}
	return tag, nil
}

func (store *EncryptedObjectStore) loadReencryptionJob(ctx context.Context) (*encryptedobject.ReencryptionJob, error) {
	return scanReencryptionJob(store.pool.QueryRow(
		ctx,
		`SELECT target_version, after_object_type, after_object_id, after_object_revision,
		        state, revision, created_at, updated_at
		   FROM vault_reencryption_jobs WHERE vault_id = $1`,
		string(store.vaultID),
	))
}

func scanReencryptionJob(row encryptedObjectRowScanner) (*encryptedobject.ReencryptionJob, error) {
	var targetVersion, revision, createdAt, updatedAt int64
	var rawKind, rawObjectID *string
	var rawObjectRevision *int64
	var rawState string
	err := row.Scan(
		&targetVersion, &rawKind, &rawObjectID, &rawObjectRevision,
		&rawState, &revision, &createdAt, &updatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("read encrypted object re-encryption job")
	}
	version, err := cryptocontent.ParseDEKVersion(targetVersion)
	if err != nil {
		return nil, ErrInvalidStoredEncryptedObject
	}
	job := encryptedobject.ReencryptionJob{
		TargetVersion: version, State: encryptedobject.ReencryptionJobState(rawState),
		Revision: revision, CreatedAtMilli: createdAt, UpdatedAtMilli: updatedAt,
	}
	if rawKind != nil || rawObjectID != nil || rawObjectRevision != nil {
		if rawKind == nil || rawObjectID == nil || rawObjectRevision == nil {
			return nil, ErrInvalidStoredEncryptedObject
		}
		parsedRevision, revisionErr := cryptocontent.ParseObjectRevision(*rawObjectRevision)
		position := encryptedobject.ReencryptionPosition{
			Object:         encryptedobject.ObjectRef{Kind: cryptocontent.ObjectKind(*rawKind), ObjectID: *rawObjectID},
			ObjectRevision: parsedRevision,
		}
		if revisionErr != nil || !validReencryptionPosition(&position) {
			return nil, ErrInvalidStoredEncryptedObject
		}
		job.After = &position
	}
	if encryptedobject.ValidateReencryptionJob(job) != nil {
		return nil, ErrInvalidStoredEncryptedObject
	}
	return &job, nil
}

func validDEKVersion(value cryptocontent.DEKVersion) bool {
	_, err := cryptocontent.ParseDEKVersion(int64(value))
	return err == nil
}

func validReencryptionPosition(value *encryptedobject.ReencryptionPosition) bool {
	if value == nil {
		return true
	}
	if encryptedobject.ValidateObjectRef(value.Object) != nil {
		return false
	}
	_, err := cryptocontent.ParseObjectRevision(int64(value.ObjectRevision))
	return err == nil
}

func nullablePositionKind(value *encryptedobject.ReencryptionPosition) any {
	if value == nil {
		return nil
	}
	return string(value.Object.Kind)
}

func nullablePositionID(value *encryptedobject.ReencryptionPosition) any {
	if value == nil {
		return nil
	}
	return value.Object.ObjectID
}

func nullablePositionRevision(value *encryptedobject.ReencryptionPosition) any {
	if value == nil {
		return nil
	}
	return int64(value.ObjectRevision)
}

func copyReencryptionPosition(value *encryptedobject.ReencryptionPosition) *encryptedobject.ReencryptionPosition {
	if value == nil {
		return nil
	}
	copyOfValue := *value
	return &copyOfValue
}

func sameReencryptionJob(left, right encryptedobject.ReencryptionJob) bool {
	if left.TargetVersion != right.TargetVersion || left.State != right.State || left.Revision != right.Revision ||
		left.CreatedAtMilli != right.CreatedAtMilli || left.UpdatedAtMilli != right.UpdatedAtMilli {
		return false
	}
	if left.After == nil || right.After == nil {
		return left.After == nil && right.After == nil
	}
	return encryptedobject.CompareReencryptionPosition(*left.After, *right.After) == 0
}
