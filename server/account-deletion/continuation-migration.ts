import type { MigrationDefinition } from '../migrations/core';

export const accountDeletionContinuationStatements = [
  `CREATE TABLE account_deletion_continuations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    idempotency_key_hash TEXT NOT NULL,
    secret_hash TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CONSTRAINT account_deletion_continuations_operation_fk FOREIGN KEY (operation_id) REFERENCES account_deletion_operations(operation_id) ON DELETE CASCADE,
    CONSTRAINT account_deletion_continuations_shape_check CHECK (
      length(idempotency_key_hash) = 43
      AND length(secret_hash) = 43
      AND sequence BETWEEN 0 AND 2147483647
      AND created_at >= 0
      AND expires_at > created_at
      AND updated_at >= created_at
      AND updated_at < expires_at
    )
  )`,
  'CREATE UNIQUE INDEX idx_account_deletion_continuations_secret ON account_deletion_continuations(secret_hash)',
  'CREATE INDEX idx_account_deletion_continuations_expiry ON account_deletion_continuations(expires_at, operation_id)',
] as const;

export const accountDeletionContinuationMigration: MigrationDefinition = {
  id: '0010_account_deletion_continuation',
  checksum:
    'sha256:3c0bfcc21d89ac55b094730f3eac7f763ee222a569cd9c3d3e716fd1c2aec60b',
  statements: accountDeletionContinuationStatements,
};
