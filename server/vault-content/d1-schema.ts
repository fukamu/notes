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

export const vaultPartitionMappings = sqliteTable(
  'vault_partition_mappings',
  {
    vaultId: text('vault_id').primaryKey(),
    accountId: text('account_id').notNull(),
    partitionId: text('partition_id').notNull(),
    routingRevision: integer('routing_revision').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_vault_partition_mappings_owner').on(
      table.accountId,
      table.vaultId,
    ),
    index('idx_vault_partition_mappings_partition_vault').on(
      table.partitionId,
      table.vaultId,
    ),
    check(
      'vault_partition_mappings_partition_check',
      sql`length(${table.partitionId}) BETWEEN 1 AND 64`,
    ),
    check(
      'vault_partition_mappings_revision_check',
      sql`${table.routingRevision} > 0`,
    ),
    check(
      'vault_partition_mappings_updated_at_check',
      sql`${table.updatedAt} >= 0`,
    ),
  ],
);

export const vaultCards = sqliteTable(
  'vault_cards',
  {
    vaultId: text('vault_id').notNull(),
    cardId: text('card_id').notNull(),
    revision: integer('revision').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vaultId, table.cardId] }),
    index('idx_vault_cards_updated').on(
      table.vaultId,
      table.updatedAt,
      table.cardId,
    ),
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaultPartitionMappings.vaultId],
      name: 'vault_cards_route_fk',
    }).onDelete('cascade'),
    check('vault_cards_revision_check', sql`${table.revision} > 0`),
    check('vault_cards_updated_at_check', sql`${table.updatedAt} >= 0`),
  ],
);

export const vaultMutationReceipts = sqliteTable(
  'vault_mutation_receipts',
  {
    vaultId: text('vault_id').notNull(),
    mutationId: text('mutation_id').notNull(),
    cardId: text('card_id').notNull(),
    appliedRevision: integer('applied_revision').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vaultId, table.mutationId] }),
    index('idx_vault_mutation_receipts_card').on(
      table.vaultId,
      table.cardId,
      table.mutationId,
    ),
    foreignKey({
      columns: [table.vaultId, table.cardId],
      foreignColumns: [vaultCards.vaultId, vaultCards.cardId],
      name: 'vault_mutation_receipts_card_fk',
    }).onDelete('cascade'),
    check(
      'vault_mutation_receipts_revision_check',
      sql`${table.appliedRevision} > 0`,
    ),
    check(
      'vault_mutation_receipts_created_at_check',
      sql`${table.createdAt} >= 0`,
    ),
  ],
);

export const vaultConflicts = sqliteTable(
  'vault_conflicts',
  {
    vaultId: text('vault_id').notNull(),
    conflictId: text('conflict_id').notNull(),
    cardId: text('card_id').notNull(),
    serverRevision: integer('server_revision').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vaultId, table.conflictId] }),
    index('idx_vault_conflicts_card').on(
      table.vaultId,
      table.cardId,
      table.conflictId,
    ),
    foreignKey({
      columns: [table.vaultId, table.cardId],
      foreignColumns: [vaultCards.vaultId, vaultCards.cardId],
      name: 'vault_conflicts_card_fk',
    }).onDelete('cascade'),
    check('vault_conflicts_revision_check', sql`${table.serverRevision} > 0`),
    check('vault_conflicts_created_at_check', sql`${table.createdAt} >= 0`),
  ],
);
