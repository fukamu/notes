import type { MigrationDefinition } from '../migrations/core';

export const dekRotationStatements = [
  `CREATE TABLE vault_dek_rotation_operations (
    vault_id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    operation_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    source_version INTEGER NOT NULL,
    target_version INTEGER NOT NULL,
    state TEXT NOT NULL,
    kek_key_reference TEXT,
    wrapped_dek TEXT,
    key_created_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    CONSTRAINT vault_dek_rotation_owner_fk FOREIGN KEY (account_id, vault_id) REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
    CONSTRAINT vault_dek_rotation_shape_check CHECK (
      revision BETWEEN 1 AND 3
      AND source_version > 0
      AND target_version = source_version + 1
      AND created_at >= 0
      AND updated_at >= created_at
      AND (
        (state = 'generating' AND revision = 1
          AND kek_key_reference IS NULL AND wrapped_dek IS NULL
          AND key_created_at IS NULL AND completed_at IS NULL)
        OR (state = 'promoting' AND revision = 2
          AND kek_key_reference IS NOT NULL
          AND length(wrapped_dek) BETWEEN 1 AND 16384
          AND key_created_at BETWEEN created_at AND updated_at
          AND completed_at IS NULL)
        OR (state = 'completed' AND revision = 3
          AND kek_key_reference IS NOT NULL
          AND length(wrapped_dek) BETWEEN 1 AND 16384
          AND key_created_at BETWEEN created_at AND updated_at
          AND completed_at = updated_at)
      )
    )
  )`,
  'CREATE UNIQUE INDEX idx_vault_dek_rotation_operation ON vault_dek_rotation_operations(operation_id)',
  'CREATE INDEX idx_vault_dek_rotation_state ON vault_dek_rotation_operations(state, updated_at, vault_id)',
] as const;

export const dekRotationMigration: MigrationDefinition = {
  id: '0011_vault_dek_rotation',
  checksum:
    'sha256:a5a5cf842c5131841000117d966855777209dcd1508d4db176f43fcc7931ba81',
  statements: dekRotationStatements,
};
