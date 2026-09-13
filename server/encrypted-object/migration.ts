import type { MigrationDefinition } from '../migrations/core';

export const encryptedObjectRepositoryStatements = [
  `CREATE TABLE vault_encrypted_objects (
    vault_id TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    object_revision INTEGER NOT NULL,
    write_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    plaintext_bytes INTEGER NOT NULL,
    ciphertext_bytes INTEGER NOT NULL,
    crypto_version TEXT NOT NULL,
    dek_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, object_type, object_id, object_revision),
    CONSTRAINT vault_encrypted_objects_route_fk FOREIGN KEY (vault_id) REFERENCES vault_partition_mappings(vault_id) ON DELETE CASCADE,
    CONSTRAINT vault_encrypted_objects_shape_check CHECK (
      object_type IN ('card', 'conflict') AND object_revision > 0
      AND length(object_key) = 50 AND plaintext_bytes >= 0 AND ciphertext_bytes > 0
      AND crypto_version = 'fukamu-envelope-aes-256-gcm/v1'
      AND dek_version > 0 AND created_at >= 0
    )
  )`,
  'CREATE UNIQUE INDEX idx_vault_encrypted_objects_write ON vault_encrypted_objects(vault_id, write_id)',
  'CREATE UNIQUE INDEX idx_vault_encrypted_objects_key ON vault_encrypted_objects(vault_id, object_key)',
  'CREATE INDEX idx_vault_encrypted_objects_current ON vault_encrypted_objects(vault_id, object_type, object_id, object_revision)',
  `CREATE TABLE vault_encrypted_write_intents (
    vault_id TEXT NOT NULL,
    write_id TEXT NOT NULL,
    object_type TEXT NOT NULL,
    object_id TEXT NOT NULL,
    expected_revision INTEGER,
    object_revision INTEGER NOT NULL,
    object_key TEXT NOT NULL,
    plaintext_bytes INTEGER NOT NULL,
    crypto_version TEXT NOT NULL,
    dek_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, write_id),
    CONSTRAINT vault_encrypted_write_intents_route_fk FOREIGN KEY (vault_id) REFERENCES vault_partition_mappings(vault_id) ON DELETE CASCADE,
    CONSTRAINT vault_encrypted_write_intents_shape_check CHECK (
      object_type IN ('card', 'conflict')
      AND (expected_revision IS NULL OR expected_revision > 0)
      AND object_revision > 0 AND length(object_key) = 50 AND plaintext_bytes >= 0
      AND crypto_version = 'fukamu-envelope-aes-256-gcm/v1'
      AND dek_version > 0 AND created_at >= 0
    )
  )`,
  'CREATE UNIQUE INDEX idx_vault_encrypted_write_intents_target ON vault_encrypted_write_intents(vault_id, object_type, object_id, object_revision)',
  'CREATE UNIQUE INDEX idx_vault_encrypted_write_intents_key ON vault_encrypted_write_intents(vault_id, object_key)',
  `CREATE TABLE vault_object_delete_outbox (
    vault_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    attempt_count INTEGER NOT NULL,
    next_attempt_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, object_key),
    CONSTRAINT vault_object_delete_outbox_attempt_check CHECK (attempt_count >= 0),
    CONSTRAINT vault_object_delete_outbox_next_attempt_check CHECK (next_attempt_at >= 0),
    CONSTRAINT vault_object_delete_outbox_created_at_check CHECK (created_at >= 0)
  )`,
  'CREATE INDEX idx_vault_object_delete_outbox_ready ON vault_object_delete_outbox(vault_id, next_attempt_at, object_key)',
] as const;

export const encryptedObjectRepositoryMigration: MigrationDefinition = {
  id: '0005_encrypted_object_repository',
  checksum:
    'sha256:67d53fb87e5c10a7cf46e42e3ee468ae295dcdc16ec5882158b0cc070092f0e1',
  statements: encryptedObjectRepositoryStatements,
};
