import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { vaultCards, vaultPartitionMappings } from './d1-schema';

export const vaultSyncV2States = sqliteTable(
  'vault_sync_v2_states',
  {
    vaultId: text('vault_id').primaryKey(),
    nextDisplayId: integer('next_display_id').notNull(),
    nextChangeSequence: integer('next_change_sequence').notNull(),
  },
  (table) => [
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaultPartitionMappings.vaultId],
      name: 'vault_sync_v2_states_route_fk',
    }).onDelete('cascade'),
    check(
      'vault_sync_v2_states_display_check',
      sql`${table.nextDisplayId} > 0`,
    ),
    check(
      'vault_sync_v2_states_sequence_check',
      sql`${table.nextChangeSequence} > 0`,
    ),
  ],
);

export const vaultCardDisplayIds = sqliteTable(
  'vault_card_display_ids',
  {
    vaultId: text('vault_id').notNull(),
    cardId: text('card_id').notNull(),
    officialDisplayId: integer('official_display_id').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vaultId, table.cardId] }),
    uniqueIndex('idx_vault_card_display_ids_official').on(
      table.vaultId,
      table.officialDisplayId,
    ),
    foreignKey({
      columns: [table.vaultId, table.cardId],
      foreignColumns: [vaultCards.vaultId, vaultCards.cardId],
      name: 'vault_card_display_ids_card_fk',
    }).onDelete('cascade'),
    check(
      'vault_card_display_ids_value_check',
      sql`${table.officialDisplayId} > 0`,
    ),
  ],
);

export const vaultSyncV2Commits = sqliteTable(
  'vault_sync_v2_commits',
  {
    vaultId: text('vault_id').notNull(),
    mutationId: text('mutation_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    cardId: text('card_id').notNull(),
    appliedRevision: integer('applied_revision').notNull(),
    committedAt: integer('committed_at').notNull(),
    state: text('state').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vaultId, table.mutationId] }),
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaultPartitionMappings.vaultId],
      name: 'vault_sync_v2_commits_route_fk',
    }).onDelete('cascade'),
    check(
      'vault_sync_v2_commits_shape_check',
      sql`length(${table.fingerprint}) = 43
        AND ${table.appliedRevision} > 0
        AND ${table.committedAt} >= 0
        AND ${table.state} IN ('pending', 'committed')`,
    ),
  ],
);

export const vaultSyncV2Changes = sqliteTable(
  'vault_sync_v2_changes',
  {
    vaultId: text('vault_id').notNull(),
    sequence: integer('sequence').notNull(),
    changeKind: text('change_kind').notNull(),
    cardId: text('card_id').notNull(),
    conflictId: text('conflict_id'),
    revision: integer('revision').notNull(),
    officialDisplayId: integer('official_display_id'),
    occurredAt: integer('occurred_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.vaultId, table.sequence] }),
    foreignKey({
      columns: [table.vaultId],
      foreignColumns: [vaultSyncV2States.vaultId],
      name: 'vault_sync_v2_changes_state_fk',
    }).onDelete('cascade'),
    check(
      'vault_sync_v2_changes_shape_check',
      sql`${table.sequence} > 0
        AND ${table.revision} > 0
        AND ${table.occurredAt} >= 0
        AND (
          (${table.changeKind} = 'card-upsert'
            AND ${table.conflictId} IS NULL
            AND ${table.officialDisplayId} > 0)
          OR (${table.changeKind} = 'card-tombstone'
            AND ${table.conflictId} IS NULL
            AND ${table.officialDisplayId} IS NULL)
          OR (${table.changeKind} IN ('conflict-upsert', 'conflict-tombstone')
            AND ${table.conflictId} IS NOT NULL
            AND ${table.officialDisplayId} IS NULL)
        )`,
    ),
  ],
);
