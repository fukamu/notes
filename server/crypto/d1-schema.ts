import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

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
