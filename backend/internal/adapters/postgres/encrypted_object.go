package postgres

import (
	"context"
	"errors"

	"github.com/fukamu/notes/backend/internal/cryptocontent"
	"github.com/fukamu/notes/backend/internal/encryptedobject"
	"github.com/fukamu/notes/backend/internal/identity"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var (
	ErrInvalidEncryptedObjectOperation = errors.New("invalid encrypted object database operation")
	ErrInvalidStoredEncryptedObject    = errors.New("invalid stored encrypted object metadata")
)

type EncryptedObjectStore struct {
	pool    *pgxpool.Pool
	vaultID identity.VaultID
}

func NewEncryptedObjectStore(pool *pgxpool.Pool, vaultID identity.VaultID) (*EncryptedObjectStore, error) {
	if pool == nil {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	if _, err := identity.ParseVaultID(string(vaultID)); err != nil {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	return &EncryptedObjectStore{pool: pool, vaultID: vaultID}, nil
}

func (store *EncryptedObjectStore) FindCurrent(
	ctx context.Context,
	object encryptedobject.ObjectRef,
) (*encryptedobject.Metadata, error) {
	if store.invalid() || encryptedobject.ValidateObjectRef(object) != nil {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	return scanEncryptedObjectMetadata(store.pool.QueryRow(
		ctx,
		`SELECT object_type, object_id, object_revision, write_id, object_key,
		        plaintext_bytes, ciphertext_bytes, crypto_version, dek_version, created_at
		   FROM vault_encrypted_objects
		  WHERE vault_id = $1 AND object_type = $2 AND object_id = $3
		  ORDER BY object_revision DESC LIMIT 1`,
		string(store.vaultID), string(object.Kind), object.ObjectID,
	))
}

func (store *EncryptedObjectStore) FindRevision(
	ctx context.Context,
	object encryptedobject.ObjectRef,
	revision cryptocontent.ObjectRevision,
) (*encryptedobject.Metadata, error) {
	if store.invalid() || encryptedobject.ValidateObjectRef(object) != nil {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	if _, err := cryptocontent.ParseObjectRevision(int64(revision)); err != nil {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	return scanEncryptedObjectMetadata(store.pool.QueryRow(
		ctx,
		`SELECT object_type, object_id, object_revision, write_id, object_key,
		        plaintext_bytes, ciphertext_bytes, crypto_version, dek_version, created_at
		   FROM vault_encrypted_objects
		  WHERE vault_id = $1 AND object_type = $2 AND object_id = $3 AND object_revision = $4`,
		string(store.vaultID), string(object.Kind), object.ObjectID, int64(revision),
	))
}

func (store *EncryptedObjectStore) FindByWriteID(
	ctx context.Context,
	writeID encryptedobject.WriteID,
) (*encryptedobject.Metadata, error) {
	if store.invalid() {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	if _, err := encryptedobject.ParseWriteID(string(writeID)); err != nil {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	return scanEncryptedObjectMetadata(store.pool.QueryRow(
		ctx,
		`SELECT object_type, object_id, object_revision, write_id, object_key,
		        plaintext_bytes, ciphertext_bytes, crypto_version, dek_version, created_at
		   FROM vault_encrypted_objects WHERE vault_id = $1 AND write_id = $2`,
		string(store.vaultID), string(writeID),
	))
}

func (store *EncryptedObjectStore) FindIntent(
	ctx context.Context,
	writeID encryptedobject.WriteID,
) (*encryptedobject.PendingWrite, error) {
	if store.invalid() {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	if _, err := encryptedobject.ParseWriteID(string(writeID)); err != nil {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	return scanPendingWrite(store.pool.QueryRow(
		ctx,
		`SELECT object_type, object_id, expected_revision, object_revision, write_id,
		        object_key, plaintext_bytes, crypto_version, dek_version, created_at
		   FROM vault_encrypted_write_intents WHERE vault_id = $1 AND write_id = $2`,
		string(store.vaultID), string(writeID),
	))
}

func (store *EncryptedObjectStore) ReserveIntent(
	ctx context.Context,
	intent encryptedobject.PendingWrite,
) (encryptedobject.IntentReservation, error) {
	if store.invalid() || encryptedobject.ValidatePendingWrite(intent) != nil {
		return encryptedobject.IntentReservation{}, ErrInvalidEncryptedObjectOperation
	}
	tag, err := store.pool.Exec(
		ctx,
		`INSERT INTO vault_encrypted_write_intents(
		   vault_id, write_id, object_type, object_id, expected_revision, object_revision,
		   object_key, plaintext_bytes, crypto_version, dek_version, created_at
		 )
		 SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
		  WHERE EXISTS (SELECT 1 FROM personal_vaults WHERE vault_id = $1)
		    AND NOT EXISTS (
		      SELECT 1 FROM vault_encrypted_objects WHERE object_key = $7
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM vault_object_delete_outbox WHERE object_key = $7
		    )
		 ON CONFLICT DO NOTHING`,
		string(store.vaultID), string(intent.WriteID), string(intent.Object.Kind), intent.Object.ObjectID,
		nullableRevision(intent.ExpectedRevision), int64(intent.ObjectRevision), string(intent.ObjectKey),
		intent.PlaintextBytes, intent.CryptoVersion, int64(intent.DEKVersion), intent.CreatedAtMilli,
	)
	if err != nil {
		return encryptedobject.IntentReservation{}, errors.New("reserve encrypted object write intent")
	}
	existing, err := store.FindIntent(ctx, intent.WriteID)
	if err != nil {
		return encryptedobject.IntentReservation{}, err
	}
	if existing == nil {
		return encryptedobject.IntentReservation{Kind: encryptedobject.IntentConflict}, nil
	}
	kind := encryptedobject.IntentExisting
	if tag.RowsAffected() == 1 {
		kind = encryptedobject.IntentReserved
	}
	return encryptedobject.IntentReservation{Kind: kind, Intent: *existing}, nil
}

func (store *EncryptedObjectStore) CommitIntent(
	ctx context.Context,
	intent encryptedobject.PendingWrite,
	ciphertextBytes int64,
) (encryptedobject.MetadataCommit, error) {
	if store.invalid() || encryptedobject.ValidatePendingWrite(intent) != nil ||
		ciphertextBytes < 1 || ciphertextBytes > encryptedobject.MaximumStoredBytes {
		return encryptedobject.MetadataCommit{}, ErrInvalidEncryptedObjectOperation
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return encryptedobject.MetadataCommit{}, errors.New("begin encrypted object commit")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	metadata, err := scanEncryptedObjectMetadata(tx.QueryRow(
		ctx,
		`INSERT INTO vault_encrypted_objects(
		   vault_id, object_type, object_id, object_revision, write_id, object_key,
		   plaintext_bytes, ciphertext_bytes, crypto_version, dek_version, created_at
		 )
		 SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11
		  WHERE EXISTS (
		    SELECT 1 FROM vault_encrypted_write_intents pending
		     WHERE pending.vault_id = $1 AND pending.write_id = $5
		       AND pending.object_key = $6 AND pending.object_type = $2
		       AND pending.object_id = $3 AND pending.object_revision = $4
		       AND pending.expected_revision IS NOT DISTINCT FROM $12
		  )
		    AND $4 = COALESCE($12, 0) + 1
		    AND (
		      ($12 IS NULL AND NOT EXISTS (
		        SELECT 1 FROM vault_encrypted_objects current
		         WHERE current.vault_id = $1 AND current.object_type = $2 AND current.object_id = $3
		      ))
		      OR
		      ($12 IS NOT NULL AND (
		        SELECT MAX(current.object_revision) FROM vault_encrypted_objects current
		         WHERE current.vault_id = $1 AND current.object_type = $2 AND current.object_id = $3
		      ) = $12)
		    )
		 ON CONFLICT DO NOTHING
		 RETURNING object_type, object_id, object_revision, write_id, object_key,
		           plaintext_bytes, ciphertext_bytes, crypto_version, dek_version, created_at`,
		string(store.vaultID), string(intent.Object.Kind), intent.Object.ObjectID,
		int64(intent.ObjectRevision), string(intent.WriteID), string(intent.ObjectKey),
		intent.PlaintextBytes, ciphertextBytes, intent.CryptoVersion, int64(intent.DEKVersion),
		intent.CreatedAtMilli, nullableRevision(intent.ExpectedRevision),
	))
	if err != nil {
		return encryptedobject.MetadataCommit{}, err
	}
	if metadata == nil {
		return encryptedobject.MetadataCommit{Kind: encryptedobject.MetadataNotApplied}, nil
	}
	tag, err := tx.Exec(
		ctx,
		`DELETE FROM vault_encrypted_write_intents
		  WHERE vault_id = $1 AND write_id = $2 AND object_key = $3`,
		string(store.vaultID), string(intent.WriteID), string(intent.ObjectKey),
	)
	if err != nil || tag.RowsAffected() != 1 {
		return encryptedobject.MetadataCommit{}, errors.New("finish encrypted object commit")
	}
	if err := tx.Commit(ctx); err != nil {
		return encryptedobject.MetadataCommit{}, errors.New("commit encrypted object metadata")
	}
	return encryptedobject.MetadataCommit{Kind: encryptedobject.MetadataApplied, Metadata: *metadata}, nil
}

func (store *EncryptedObjectStore) AbandonIntent(
	ctx context.Context,
	intent encryptedobject.PendingWrite,
	requestedAt int64,
) error {
	if store.invalid() || encryptedobject.ValidatePendingWrite(intent) != nil ||
		requestedAt < 0 || requestedAt > identity.MaximumSafeInteger {
		return ErrInvalidEncryptedObjectOperation
	}
	tx, err := store.pool.Begin(ctx)
	if err != nil {
		return errors.New("begin encrypted object abandon")
	}
	defer func() { _ = tx.Rollback(context.Background()) }()
	if _, err := tx.Exec(
		ctx,
		`INSERT INTO vault_object_delete_outbox(
		   vault_id, object_key, attempt_count, next_attempt_at, created_at
		 )
		 SELECT $1, $2, 0, $3, $3
		  WHERE EXISTS (
		    SELECT 1 FROM vault_encrypted_write_intents
		     WHERE vault_id = $1 AND write_id = $4 AND object_key = $2
		  )
		    AND NOT EXISTS (SELECT 1 FROM vault_encrypted_objects WHERE object_key = $2)
		 ON CONFLICT DO NOTHING`,
		string(store.vaultID), string(intent.ObjectKey), requestedAt, string(intent.WriteID),
	); err != nil {
		return errors.New("enqueue abandoned encrypted object")
	}
	if _, err := tx.Exec(
		ctx,
		`DELETE FROM vault_encrypted_write_intents
		  WHERE vault_id = $1 AND write_id = $2 AND object_key = $3`,
		string(store.vaultID), string(intent.WriteID), string(intent.ObjectKey),
	); err != nil {
		return errors.New("delete encrypted object intent")
	}
	if err := tx.Commit(ctx); err != nil {
		return errors.New("commit encrypted object abandon")
	}
	return nil
}

func (store *EncryptedObjectStore) ListProtectedObjectKeys(
	ctx context.Context,
) (map[encryptedobject.ObjectKey]struct{}, error) {
	if store.invalid() {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	rows, err := store.pool.Query(
		ctx,
		`SELECT object_key FROM vault_encrypted_objects
		 UNION
		 SELECT object_key FROM vault_encrypted_write_intents`,
	)
	if err != nil {
		return nil, errors.New("list protected encrypted object keys")
	}
	defer rows.Close()
	result := make(map[encryptedobject.ObjectKey]struct{})
	for rows.Next() {
		var raw string
		if err := rows.Scan(&raw); err != nil {
			return nil, ErrInvalidStoredEncryptedObject
		}
		key, err := encryptedobject.ParseObjectKey(raw)
		if err != nil {
			return nil, ErrInvalidStoredEncryptedObject
		}
		result[key] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("list protected encrypted object keys")
	}
	return result, nil
}

func (store *EncryptedObjectStore) EnqueueDelete(
	ctx context.Context,
	objectKey encryptedobject.ObjectKey,
	requestedAt int64,
) (bool, error) {
	if store.invalid() || requestedAt < 0 || requestedAt > identity.MaximumSafeInteger {
		return false, ErrInvalidEncryptedObjectOperation
	}
	if _, err := encryptedobject.ParseObjectKey(string(objectKey)); err != nil {
		return false, ErrInvalidEncryptedObjectOperation
	}
	tag, err := store.pool.Exec(
		ctx,
		`INSERT INTO vault_object_delete_outbox(
		   vault_id, object_key, attempt_count, next_attempt_at, created_at
		 )
		 SELECT $1, $2, 0, $3, $3
		  WHERE EXISTS (SELECT 1 FROM personal_vaults WHERE vault_id = $1)
		    AND NOT EXISTS (SELECT 1 FROM vault_encrypted_objects WHERE object_key = $2)
		    AND NOT EXISTS (SELECT 1 FROM vault_encrypted_write_intents WHERE object_key = $2)
		 ON CONFLICT DO NOTHING`,
		string(store.vaultID), string(objectKey), requestedAt,
	)
	if err != nil {
		return false, errors.New("enqueue encrypted object delete")
	}
	return tag.RowsAffected() == 1, nil
}

func (store *EncryptedObjectStore) ListReadyDeletes(
	ctx context.Context,
	now int64,
	limit int,
) ([]encryptedobject.DeleteOutboxEntry, error) {
	if store.invalid() || now < 0 || now > identity.MaximumSafeInteger || limit < 1 || limit > 100 {
		return nil, ErrInvalidEncryptedObjectOperation
	}
	rows, err := store.pool.Query(
		ctx,
		`SELECT pending.object_key, pending.attempt_count, pending.next_attempt_at, pending.created_at
		   FROM vault_object_delete_outbox pending
		  WHERE pending.vault_id = $1 AND pending.next_attempt_at <= $2
		    AND NOT EXISTS (
		      SELECT 1 FROM vault_encrypted_objects stored WHERE stored.object_key = pending.object_key
		    )
		    AND NOT EXISTS (
		      SELECT 1 FROM vault_encrypted_write_intents intent WHERE intent.object_key = pending.object_key
		    )
		  ORDER BY pending.next_attempt_at, pending.object_key LIMIT $3`,
		string(store.vaultID), now, limit,
	)
	if err != nil {
		return nil, errors.New("list encrypted object deletes")
	}
	defer rows.Close()
	result := make([]encryptedobject.DeleteOutboxEntry, 0)
	for rows.Next() {
		var rawKey string
		var entry encryptedobject.DeleteOutboxEntry
		if err := rows.Scan(&rawKey, &entry.AttemptCount, &entry.NextAttemptAt, &entry.CreatedAtMilli); err != nil {
			return nil, ErrInvalidStoredEncryptedObject
		}
		key, err := encryptedobject.ParseObjectKey(rawKey)
		if err != nil || entry.AttemptCount < 0 || entry.NextAttemptAt < 0 || entry.CreatedAtMilli < 0 {
			return nil, ErrInvalidStoredEncryptedObject
		}
		entry.ObjectKey = key
		result = append(result, entry)
	}
	if err := rows.Err(); err != nil {
		return nil, errors.New("list encrypted object deletes")
	}
	return result, nil
}

func (store *EncryptedObjectStore) CompleteDelete(
	ctx context.Context,
	entry encryptedobject.DeleteOutboxEntry,
) error {
	if store.invalid() || !validDeleteEntry(entry) {
		return ErrInvalidEncryptedObjectOperation
	}
	_, err := store.pool.Exec(
		ctx,
		`DELETE FROM vault_object_delete_outbox
		  WHERE vault_id = $1 AND object_key = $2 AND attempt_count = $3`,
		string(store.vaultID), string(entry.ObjectKey), entry.AttemptCount,
	)
	if err != nil {
		return errors.New("complete encrypted object delete")
	}
	return nil
}

func (store *EncryptedObjectStore) RescheduleDelete(
	ctx context.Context,
	entry encryptedobject.DeleteOutboxEntry,
) error {
	if store.invalid() || !validDeleteEntry(entry) || entry.AttemptCount < 1 {
		return ErrInvalidEncryptedObjectOperation
	}
	_, err := store.pool.Exec(
		ctx,
		`UPDATE vault_object_delete_outbox
		    SET attempt_count = $1, next_attempt_at = $2
		  WHERE vault_id = $3 AND object_key = $4 AND attempt_count = $5`,
		entry.AttemptCount, entry.NextAttemptAt, string(store.vaultID), string(entry.ObjectKey), entry.AttemptCount-1,
	)
	if err != nil {
		return errors.New("reschedule encrypted object delete")
	}
	return nil
}

type encryptedObjectRowScanner interface {
	Scan(...any) error
}

func scanEncryptedObjectMetadata(row encryptedObjectRowScanner) (*encryptedobject.Metadata, error) {
	var rawKind, objectID, rawWriteID, rawObjectKey, cryptoVersion string
	var revision, dekVersion int64
	var metadata encryptedobject.Metadata
	err := row.Scan(
		&rawKind, &objectID, &revision, &rawWriteID, &rawObjectKey,
		&metadata.PlaintextBytes, &metadata.CiphertextBytes, &cryptoVersion, &dekVersion, &metadata.CreatedAtMilli,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("read encrypted object metadata")
	}
	parsed, err := buildMetadata(rawKind, objectID, revision, rawWriteID, rawObjectKey, cryptoVersion, dekVersion, metadata)
	if err != nil {
		return nil, err
	}
	return &parsed, nil
}

func buildMetadata(
	rawKind, objectID string,
	revision int64,
	rawWriteID, rawObjectKey, cryptoVersion string,
	dekVersion int64,
	metadata encryptedobject.Metadata,
) (encryptedobject.Metadata, error) {
	objectRevision, revisionErr := cryptocontent.ParseObjectRevision(revision)
	writeID, writeErr := encryptedobject.ParseWriteID(rawWriteID)
	objectKey, keyErr := encryptedobject.ParseObjectKey(rawObjectKey)
	parsedDEKVersion, dekErr := cryptocontent.ParseDEKVersion(dekVersion)
	metadata.Object = encryptedobject.ObjectRef{Kind: cryptocontent.ObjectKind(rawKind), ObjectID: objectID}
	metadata.ObjectRevision = objectRevision
	metadata.WriteID = writeID
	metadata.ObjectKey = objectKey
	metadata.CryptoVersion = cryptoVersion
	metadata.DEKVersion = parsedDEKVersion
	if revisionErr != nil || writeErr != nil || keyErr != nil || dekErr != nil ||
		encryptedobject.ValidateMetadata(metadata) != nil {
		return encryptedobject.Metadata{}, ErrInvalidStoredEncryptedObject
	}
	return metadata, nil
}

func scanPendingWrite(row encryptedObjectRowScanner) (*encryptedobject.PendingWrite, error) {
	var rawKind, objectID, rawWriteID, rawObjectKey, cryptoVersion string
	var expectedRevision *int64
	var revision, dekVersion int64
	var intent encryptedobject.PendingWrite
	err := row.Scan(
		&rawKind, &objectID, &expectedRevision, &revision, &rawWriteID, &rawObjectKey,
		&intent.PlaintextBytes, &cryptoVersion, &dekVersion, &intent.CreatedAtMilli,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, errors.New("read encrypted object write intent")
	}
	objectRevision, revisionErr := cryptocontent.ParseObjectRevision(revision)
	writeID, writeErr := encryptedobject.ParseWriteID(rawWriteID)
	objectKey, keyErr := encryptedobject.ParseObjectKey(rawObjectKey)
	parsedDEKVersion, dekErr := cryptocontent.ParseDEKVersion(dekVersion)
	intent.Object = encryptedobject.ObjectRef{Kind: cryptocontent.ObjectKind(rawKind), ObjectID: objectID}
	intent.ExpectedRevision = parseNullableRevision(expectedRevision)
	intent.ObjectRevision = objectRevision
	intent.WriteID = writeID
	intent.ObjectKey = objectKey
	intent.CryptoVersion = cryptoVersion
	intent.DEKVersion = parsedDEKVersion
	if revisionErr != nil || writeErr != nil || keyErr != nil || dekErr != nil ||
		(expectedRevision != nil && intent.ExpectedRevision == nil) || encryptedobject.ValidatePendingWrite(intent) != nil {
		return nil, ErrInvalidStoredEncryptedObject
	}
	return &intent, nil
}

func (store *EncryptedObjectStore) invalid() bool {
	return store == nil || store.pool == nil
}

func nullableRevision(value *cryptocontent.ObjectRevision) any {
	if value == nil {
		return nil
	}
	return int64(*value)
}

func parseNullableRevision(value *int64) *cryptocontent.ObjectRevision {
	if value == nil {
		return nil
	}
	parsed, err := cryptocontent.ParseObjectRevision(*value)
	if err != nil {
		return nil
	}
	return &parsed
}

func validDeleteEntry(entry encryptedobject.DeleteOutboxEntry) bool {
	if _, err := encryptedobject.ParseObjectKey(string(entry.ObjectKey)); err != nil {
		return false
	}
	return entry.AttemptCount >= 0 && entry.NextAttemptAt >= 0 &&
		entry.NextAttemptAt <= identity.MaximumSafeInteger && entry.CreatedAtMilli >= 0 &&
		entry.CreatedAtMilli <= identity.MaximumSafeInteger
}
