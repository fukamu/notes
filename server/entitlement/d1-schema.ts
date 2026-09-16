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

export const entitlementProjections = sqliteTable(
  'entitlement_projections',
  {
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    version: integer('version').notNull(),
    sourceSubscriptionId: text('source_subscription_id').notNull(),
    sourceBillingVersion: integer('source_billing_version').notNull(),
    state: text('state').notNull(),
    validUntil: integer('valid_until'),
    lockReason: text('lock_reason'),
    checkedAt: integer('checked_at').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.accountId, table.vaultId] }),
    index('idx_entitlement_projection_state').on(
      table.state,
      table.checkedAt,
      table.vaultId,
    ),
    foreignKey({
      columns: [table.accountId, table.vaultId],
      foreignColumns: [personalVaults.accountId, personalVaults.vaultId],
      name: 'entitlement_projection_owner_fk',
    }).onDelete('cascade'),
    check(
      'entitlement_projection_shape_check',
      sql`${table.version} > 0 AND ${table.sourceBillingVersion} > 0
        AND ${table.state} IN ('trial-active', 'paid-active', 'locked')
        AND ${table.checkedAt} >= 0 AND ${table.createdAt} >= 0
        AND ${table.updatedAt} = ${table.checkedAt}
        AND ${table.updatedAt} >= ${table.createdAt}
        AND (
          (${table.state} IN ('trial-active', 'paid-active')
            AND ${table.validUntil} > ${table.checkedAt}
            AND ${table.lockReason} IS NULL)
          OR (${table.state} = 'locked'
            AND ${table.validUntil} IS NULL
            AND ${table.lockReason} IN (
              'checkout-incomplete', 'payment-method-required',
              'trial-expired', 'paid-period-expired', 'payment-failed',
              'payment-action-required', 'cancelled'
            ))
        )`,
    ),
  ],
);

export const entitlementOfflineLeases = sqliteTable(
  'entitlement_offline_leases',
  {
    leaseId: text('lease_id').primaryKey(),
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    sessionId: text('session_id').notNull(),
    sessionEpoch: integer('session_epoch').notNull(),
    sourceSubscriptionId: text('source_subscription_id').notNull(),
    sourceBillingVersion: integer('source_billing_version').notNull(),
    basis: text('basis').notNull(),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    index('idx_entitlement_leases_owner').on(
      table.accountId,
      table.vaultId,
      table.expiresAt,
      table.leaseId,
    ),
    index('idx_entitlement_leases_expiry').on(
      table.expiresAt,
      table.revokedAt,
      table.leaseId,
    ),
    foreignKey({
      columns: [table.accountId, table.vaultId],
      foreignColumns: [
        entitlementProjections.accountId,
        entitlementProjections.vaultId,
      ],
      name: 'entitlement_lease_projection_fk',
    }).onDelete('cascade'),
    check(
      'entitlement_offline_lease_shape_check',
      sql`${table.sessionEpoch} > 0 AND ${table.sourceBillingVersion} > 0
        AND ${table.basis} IN ('trial', 'paid')
        AND ${table.issuedAt} >= 0 AND ${table.expiresAt} > ${table.issuedAt}
        AND ${table.createdAt} = ${table.issuedAt}
        AND (${table.revokedAt} IS NULL OR ${table.revokedAt} >= ${table.issuedAt})`,
    ),
  ],
);
