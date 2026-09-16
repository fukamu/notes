import type { MigrationDefinition } from '../migrations/core';

export const accountDeletionSagaStatements = [
  `CREATE TABLE account_deletion_operations (
    operation_id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    current_step TEXT,
    attempt INTEGER NOT NULL,
    not_before INTEGER,
    lease_expires_at INTEGER,
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    CONSTRAINT account_deletion_operations_shape_check CHECK (
      revision > 0 AND attempt >= 0 AND created_at >= 0
      AND updated_at >= created_at
      AND (current_step IS NULL OR current_step IN (
        'revoke-sessions', 'cancel-subscription', 'delete-vault-data',
        'delete-private-objects', 'finalize-account'
      ))
      AND (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64)
      AND (
        (state = 'ready' AND current_step IS NOT NULL
          AND not_before >= updated_at AND lease_expires_at IS NULL
          AND failure_code IS NULL AND completed_at IS NULL)
        OR (state = 'running' AND current_step IS NOT NULL AND attempt > 0
          AND not_before IS NULL AND lease_expires_at > updated_at
          AND failure_code IS NULL AND completed_at IS NULL)
        OR (state = 'retry-wait' AND current_step IS NOT NULL AND attempt > 0
          AND not_before >= updated_at AND lease_expires_at IS NULL
          AND failure_code IS NOT NULL AND completed_at IS NULL)
        OR (state = 'terminal-failure' AND current_step IS NOT NULL AND attempt > 0
          AND not_before IS NULL AND lease_expires_at IS NULL
          AND failure_code IS NOT NULL AND completed_at IS NULL)
        OR (state = 'completed' AND current_step IS NULL AND attempt = 0
          AND not_before IS NULL AND lease_expires_at IS NULL
          AND failure_code IS NULL AND completed_at = updated_at)
      )
    )
  )`,
  'CREATE UNIQUE INDEX idx_account_deletion_operations_account ON account_deletion_operations(account_id)',
  'CREATE INDEX idx_account_deletion_operations_ready ON account_deletion_operations(state, not_before, operation_id)',
  `CREATE TABLE account_deletion_step_receipts (
    operation_id TEXT NOT NULL,
    step TEXT NOT NULL,
    completed_at INTEGER NOT NULL,
    PRIMARY KEY (operation_id, step),
    CONSTRAINT account_deletion_receipts_operation_fk FOREIGN KEY (operation_id) REFERENCES account_deletion_operations(operation_id) ON DELETE CASCADE,
    CONSTRAINT account_deletion_receipts_shape_check CHECK (
      step IN (
        'revoke-sessions', 'cancel-subscription', 'delete-vault-data',
        'delete-private-objects', 'finalize-account'
      ) AND completed_at >= 0
    )
  )`,
] as const;

export const accountDeletionSagaMigration: MigrationDefinition = {
  id: '0009_account_deletion_saga',
  checksum:
    'sha256:43e339e2742d3522cdeee484bc8537a731088d0b4474b7b69008fe2aeaa7dd4e',
  statements: accountDeletionSagaStatements,
};
