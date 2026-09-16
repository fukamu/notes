import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const accountDeletionOperations = sqliteTable(
  'account_deletion_operations',
  {
    operationId: text('operation_id').primaryKey(),
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    revision: integer('revision').notNull(),
    state: text('state').notNull(),
    currentStep: text('current_step'),
    attempt: integer('attempt').notNull(),
    notBefore: integer('not_before'),
    leaseExpiresAt: integer('lease_expires_at'),
    failureCode: text('failure_code'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [
    uniqueIndex('idx_account_deletion_operations_account').on(table.accountId),
    index('idx_account_deletion_operations_ready').on(
      table.state,
      table.notBefore,
      table.operationId,
    ),
    check(
      'account_deletion_operations_shape_check',
      sql`${table.revision} > 0
        AND ${table.attempt} >= 0
        AND ${table.createdAt} >= 0
        AND ${table.updatedAt} >= ${table.createdAt}
        AND (${table.currentStep} IS NULL OR ${table.currentStep} IN (
          'revoke-sessions', 'cancel-subscription', 'delete-vault-data',
          'delete-private-objects', 'finalize-account'
        ))
        AND (${table.failureCode} IS NULL OR length(${table.failureCode}) BETWEEN 1 AND 64)
        AND (
          (${table.state} = 'ready'
            AND ${table.currentStep} IS NOT NULL
            AND ${table.notBefore} >= ${table.updatedAt}
            AND ${table.leaseExpiresAt} IS NULL
            AND ${table.failureCode} IS NULL
            AND ${table.completedAt} IS NULL)
          OR (${table.state} = 'running'
            AND ${table.currentStep} IS NOT NULL
            AND ${table.attempt} > 0
            AND ${table.notBefore} IS NULL
            AND ${table.leaseExpiresAt} > ${table.updatedAt}
            AND ${table.failureCode} IS NULL
            AND ${table.completedAt} IS NULL)
          OR (${table.state} = 'retry-wait'
            AND ${table.currentStep} IS NOT NULL
            AND ${table.attempt} > 0
            AND ${table.notBefore} >= ${table.updatedAt}
            AND ${table.leaseExpiresAt} IS NULL
            AND ${table.failureCode} IS NOT NULL
            AND ${table.completedAt} IS NULL)
          OR (${table.state} = 'terminal-failure'
            AND ${table.currentStep} IS NOT NULL
            AND ${table.attempt} > 0
            AND ${table.notBefore} IS NULL
            AND ${table.leaseExpiresAt} IS NULL
            AND ${table.failureCode} IS NOT NULL
            AND ${table.completedAt} IS NULL)
          OR (${table.state} = 'completed'
            AND ${table.currentStep} IS NULL
            AND ${table.attempt} = 0
            AND ${table.notBefore} IS NULL
            AND ${table.leaseExpiresAt} IS NULL
            AND ${table.failureCode} IS NULL
            AND ${table.completedAt} = ${table.updatedAt})
        )`,
    ),
  ],
);

export const accountDeletionStepReceipts = sqliteTable(
  'account_deletion_step_receipts',
  {
    operationId: text('operation_id').notNull(),
    step: text('step').notNull(),
    completedAt: integer('completed_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.operationId, table.step] }),
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [accountDeletionOperations.operationId],
      name: 'account_deletion_receipts_operation_fk',
    }).onDelete('cascade'),
    check(
      'account_deletion_receipts_shape_check',
      sql`${table.step} IN (
          'revoke-sessions', 'cancel-subscription', 'delete-vault-data',
          'delete-private-objects', 'finalize-account'
        ) AND ${table.completedAt} >= 0`,
    ),
  ],
);

export const accountDeletionContinuations = sqliteTable(
  'account_deletion_continuations',
  {
    operationId: text('operation_id').primaryKey(),
    idempotencyKeyHash: text('idempotency_key_hash').notNull(),
    secretHash: text('secret_hash').notNull(),
    sequence: integer('sequence').notNull(),
    expiresAt: integer('expires_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_account_deletion_continuations_secret').on(
      table.secretHash,
    ),
    index('idx_account_deletion_continuations_expiry').on(
      table.expiresAt,
      table.operationId,
    ),
    foreignKey({
      columns: [table.operationId],
      foreignColumns: [accountDeletionOperations.operationId],
      name: 'account_deletion_continuations_operation_fk',
    }).onDelete('cascade'),
    check(
      'account_deletion_continuations_shape_check',
      sql`length(${table.idempotencyKeyHash}) = 43
        AND length(${table.secretHash}) = 43
        AND ${table.sequence} BETWEEN 0 AND 2147483647
        AND ${table.createdAt} >= 0
        AND ${table.expiresAt} > ${table.createdAt}
        AND ${table.updatedAt} >= ${table.createdAt}
        AND ${table.updatedAt} < ${table.expiresAt}`,
    ),
  ],
);
