import type { MigrationDefinition } from '../migrations/core';

export const envelopeEncryptionMetadataStatements = [
  `CREATE TABLE vault_dek_versions (
    vault_id TEXT NOT NULL,
    dek_version INTEGER NOT NULL,
    kek_key_reference TEXT NOT NULL,
    wrapped_dek TEXT NOT NULL,
    is_write_key INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, dek_version),
    CONSTRAINT vault_dek_versions_version_check CHECK (dek_version > 0),
    CONSTRAINT vault_dek_versions_write_check CHECK (is_write_key IN (0, 1)),
    CONSTRAINT vault_dek_versions_wrapped_check CHECK (length(wrapped_dek) BETWEEN 1 AND 16384),
    CONSTRAINT vault_dek_versions_created_at_check CHECK (created_at >= 0)
  )`,
  'CREATE UNIQUE INDEX idx_vault_dek_versions_write ON vault_dek_versions(vault_id, is_write_key) WHERE is_write_key = 1',
  'CREATE INDEX idx_vault_dek_versions_created ON vault_dek_versions(vault_id, created_at, dek_version)',
] as const;

export const envelopeEncryptionMetadataMigration: MigrationDefinition = {
  id: '0004_envelope_encryption_metadata',
  checksum:
    'sha256:735d32bdd3a697720a8a53b6ccde9ead7bf7aa61f0f3968cc4423701c9ee71d3',
  statements: envelopeEncryptionMetadataStatements,
};
