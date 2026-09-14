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
import { personalVaults } from '../control-plane/d1-schema';

export const vaultDekVersions = sqliteTable(
  'vault_dek_versions',
  {
    vaultId: text('vault_id').notNull(),
    dekVersion: integer('dek_version').notNull(),
    kekKeyReference: text('kek_key_reference').notNull(),
    wrappedDek: text('wrapped_dek').notNull(),
    isWriteKey: integer('is_write_key').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vaultId, table.dekVersion] }),
    uniqueIndex('idx_vault_dek_versions_write')
      .on(table.vaultId, table.isWriteKey)
      .where(sql`${table.isWriteKey} = 1`),
    index('idx_vault_dek_versions_created').on(
      table.vaultId,
      table.createdAt,
      table.dekVersion,
    ),
    check('vault_dek_versions_version_check', sql`${table.dekVersion} > 0`),
    check('vault_dek_versions_write_check', sql`${table.isWriteKey} IN (0, 1)`),
    check(
      'vault_dek_versions_wrapped_check',
      sql`length(${table.wrappedDek}) BETWEEN 1 AND 16384`,
    ),
    check('vault_dek_versions_created_at_check', sql`${table.createdAt} >= 0`),
  ],
);

export const vaultDekRotationOperations = sqliteTable(
  'vault_dek_rotation_operations',
  {
    vaultId: text('vault_id').primaryKey(),
    accountId: text('account_id').notNull(),
    operationId: text('operation_id').notNull(),
    revision: integer('revision').notNull(),
    sourceVersion: integer('source_version').notNull(),
    targetVersion: integer('target_version').notNull(),
    state: text('state').notNull(),
    kekKeyReference: text('kek_key_reference'),
    wrappedDek: text('wrapped_dek'),
    keyCreatedAt: integer('key_created_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    completedAt: integer('completed_at'),
  },
  (table) => [
    uniqueIndex('idx_vault_dek_rotation_operation').on(table.operationId),
    index('idx_vault_dek_rotation_state').on(
      table.state,
      table.updatedAt,
      table.vaultId,
    ),
    foreignKey({
      columns: [table.accountId, table.vaultId],
      foreignColumns: [personalVaults.accountId, personalVaults.vaultId],
      name: 'vault_dek_rotation_owner_fk',
    }).onDelete('cascade'),
    check(
      'vault_dek_rotation_shape_check',
      sql`${table.revision} BETWEEN 1 AND 3
        AND ${table.sourceVersion} > 0
        AND ${table.targetVersion} = ${table.sourceVersion} + 1
        AND ${table.createdAt} >= 0
        AND ${table.updatedAt} >= ${table.createdAt}
        AND (
          (${table.state} = 'generating' AND ${table.revision} = 1
            AND ${table.kekKeyReference} IS NULL
            AND ${table.wrappedDek} IS NULL
            AND ${table.keyCreatedAt} IS NULL
            AND ${table.completedAt} IS NULL)
          OR (${table.state} = 'promoting' AND ${table.revision} = 2
            AND ${table.kekKeyReference} IS NOT NULL
            AND length(${table.wrappedDek}) BETWEEN 1 AND 16384
            AND ${table.keyCreatedAt} BETWEEN ${table.createdAt} AND ${table.updatedAt}
            AND ${table.completedAt} IS NULL)
          OR (${table.state} = 'completed' AND ${table.revision} = 3
            AND ${table.kekKeyReference} IS NOT NULL
            AND length(${table.wrappedDek}) BETWEEN 1 AND 16384
            AND ${table.keyCreatedAt} BETWEEN ${table.createdAt} AND ${table.updatedAt}
            AND ${table.completedAt} = ${table.updatedAt})
        )`,
    ),
  ],
);
