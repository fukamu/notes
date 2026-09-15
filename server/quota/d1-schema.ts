import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';
import { personalVaults } from '../control-plane/d1-schema';

export const vaultQuotaUsage = sqliteTable(
  'vault_quota_usage',
  {
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    revision: integer('revision').notNull(),
    activeCards: integer('active_cards').notNull(),
    plaintextBytes: integer('plaintext_bytes').notNull(),
    lastTransitionReservationId: text('last_transition_reservation_id'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.vaultId] }),
    foreignKey({
      columns: [table.accountId, table.vaultId],
      foreignColumns: [personalVaults.accountId, personalVaults.vaultId],
      name: 'vault_quota_usage_owner_fk',
    }).onDelete('cascade'),
    check(
      'vault_quota_usage_shape_check',
      sql`${table.revision} > 0
        AND ${table.activeCards} >= 0
        AND ${table.plaintextBytes} >= 0
        AND (${table.lastTransitionReservationId} IS NULL
          OR length(${table.lastTransitionReservationId}) = 36)
        AND ${table.createdAt} >= 0
        AND ${table.updatedAt} >= ${table.createdAt}`,
    ),
  ],
);

export const vaultQuotaReservations = sqliteTable(
  'vault_quota_reservations',
  {
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    reservationId: text('reservation_id').notNull(),
    fingerprint: text('fingerprint').notNull(),
    cardId: text('card_id').notNull(),
    changeKind: text('change_kind').notNull(),
    cardDelta: integer('card_delta').notNull(),
    plaintextByteDelta: integer('plaintext_byte_delta').notNull(),
    chargedCardDelta: integer('charged_card_delta').notNull(),
    chargedPlaintextByteDelta: integer(
      'charged_plaintext_byte_delta',
    ).notNull(),
    usageRevisionAtReservation: integer(
      'usage_revision_at_reservation',
    ).notNull(),
    state: text('state').notNull(),
    createdAt: integer('created_at').notNull(),
    reconcileAfter: integer('reconcile_after').notNull(),
    finalizedAt: integer('finalized_at'),
    finalizedUsageRevision: integer('finalized_usage_revision'),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.vaultId, table.reservationId],
    }),
    foreignKey({
      columns: [table.accountId, table.vaultId],
      foreignColumns: [personalVaults.accountId, personalVaults.vaultId],
      name: 'vault_quota_reservations_owner_fk',
    }).onDelete('cascade'),
    index('idx_vault_quota_reservations_reconcile').on(
      table.accountId,
      table.vaultId,
      table.state,
      table.reconcileAfter,
      table.reservationId,
    ),
    check(
      'vault_quota_reservations_shape_check',
      sql`length(${table.reservationId}) = 36
        AND length(${table.fingerprint}) = 43
        AND length(${table.cardId}) = 36
        AND ${table.usageRevisionAtReservation} > 0
        AND ${table.createdAt} >= 0
        AND ${table.reconcileAfter} > ${table.createdAt}
        AND (
          (${table.changeKind} = 'create'
            AND ${table.cardDelta} = 1
            AND ${table.plaintextByteDelta} >= 0
            AND ${table.chargedCardDelta} = 1
            AND ${table.chargedPlaintextByteDelta} = ${table.plaintextByteDelta})
          OR (${table.changeKind} = 'update'
            AND ${table.cardDelta} = 0
            AND ${table.chargedCardDelta} = 0
            AND ${table.chargedPlaintextByteDelta} =
              CASE WHEN ${table.plaintextByteDelta} > 0
                THEN ${table.plaintextByteDelta} ELSE 0 END)
          OR (${table.changeKind} = 'delete'
            AND ${table.cardDelta} = -1
            AND ${table.plaintextByteDelta} <= 0
            AND ${table.chargedCardDelta} = 0
            AND ${table.chargedPlaintextByteDelta} = 0)
        )
        AND (
          (${table.state} = 'reserved'
            AND ${table.finalizedAt} IS NULL
            AND ${table.finalizedUsageRevision} IS NULL)
          OR (${table.state} IN ('committed', 'released')
            AND ${table.finalizedAt} >= ${table.createdAt}
            AND ${table.finalizedUsageRevision} > ${table.usageRevisionAtReservation})
        )`,
    ),
  ],
);

export const vaultQuotaFinalizationAssertions = sqliteTable(
  'vault_quota_finalization_assertions',
  {
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    reservationId: text('reservation_id').notNull(),
    assertionPassed: integer('assertion_passed').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.vaultId, table.reservationId],
    }),
    foreignKey({
      columns: [table.accountId, table.vaultId],
      foreignColumns: [personalVaults.accountId, personalVaults.vaultId],
      name: 'vault_quota_finalization_assertions_owner_fk',
    }).onDelete('cascade'),
    check(
      'vault_quota_finalization_assertions_shape_check',
      sql`length(${table.reservationId}) = 36
        AND ${table.assertionPassed} = 1`,
    ),
  ],
);
