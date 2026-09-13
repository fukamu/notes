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

export const billingSubscriptions = sqliteTable(
  'billing_subscriptions',
  {
    subscriptionId: text('subscription_id').primaryKey(),
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    provider: text('provider').notNull(),
    providerCustomerReference: text('provider_customer_ref'),
    providerSubscriptionReference: text('provider_subscription_ref'),
    version: integer('version').notNull(),
    status: text('status').notNull(),
    paymentMethodReady: integer('payment_method_ready').notNull(),
    paymentMethodUpdatedAt: integer('payment_method_updated_at'),
    trialStartedAt: integer('trial_started_at'),
    trialEndsAt: integer('trial_ends_at'),
    trialObservedAt: integer('trial_observed_at'),
    paidPeriodStartedAt: integer('paid_period_started_at'),
    paidPeriodEndsAt: integer('paid_period_ends_at'),
    lastPaidAt: integer('last_paid_at'),
    lastPaidInvoiceReference: text('last_paid_invoice_ref'),
    delinquencyReason: text('delinquency_reason'),
    delinquencySince: integer('delinquency_since'),
    delinquencyInvoiceReference: text('delinquency_invoice_ref'),
    cancelAt: integer('cancel_at'),
    cancellationUpdatedAt: integer('cancellation_updated_at'),
    cancelledAt: integer('cancelled_at'),
    lastReconciledAt: integer('last_reconciled_at'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_billing_subscriptions_owner').on(
      table.accountId,
      table.vaultId,
    ),
    uniqueIndex('idx_billing_subscriptions_customer').on(
      table.provider,
      table.providerCustomerReference,
    ),
    uniqueIndex('idx_billing_subscriptions_provider_subscription').on(
      table.provider,
      table.providerSubscriptionReference,
    ),
    index('idx_billing_subscriptions_status').on(
      table.status,
      table.updatedAt,
      table.subscriptionId,
    ),
    foreignKey({
      columns: [table.accountId, table.vaultId],
      foreignColumns: [personalVaults.accountId, personalVaults.vaultId],
      name: 'billing_subscriptions_owner_fk',
    }).onDelete('cascade'),
    check(
      'billing_subscriptions_shape_check',
      sql`${table.version} > 0
        AND ${table.status} IN ('checkout-pending', 'trialing', 'active', 'delinquent', 'cancelled')
        AND ${table.paymentMethodReady} IN (0, 1)
        AND (${table.providerCustomerReference} IS NULL) = (${table.providerSubscriptionReference} IS NULL)
        AND (${table.lastPaidAt} IS NULL) = (${table.lastPaidInvoiceReference} IS NULL)
        AND ${table.createdAt} >= 0 AND ${table.updatedAt} >= ${table.createdAt}
        AND (${table.status} <> 'trialing' OR (
          ${table.trialStartedAt} IS NOT NULL AND ${table.trialEndsAt} > ${table.trialStartedAt}
        ))
        AND (${table.status} <> 'active' OR (
          ${table.paidPeriodStartedAt} IS NOT NULL AND ${table.paidPeriodEndsAt} > ${table.paidPeriodStartedAt}
          AND ${table.delinquencyReason} IS NULL AND ${table.delinquencySince} IS NULL
          AND ${table.delinquencyInvoiceReference} IS NULL
        ))
        AND (${table.status} <> 'delinquent' OR (
          ${table.delinquencyReason} IN ('payment-failed', 'payment-action-required')
          AND ${table.delinquencySince} IS NOT NULL AND ${table.delinquencyInvoiceReference} IS NOT NULL
        ))
        AND (${table.status} <> 'cancelled' OR ${table.cancelledAt} IS NOT NULL)`,
    ),
  ],
);

export const billingCheckoutIntents = sqliteTable(
  'billing_checkout_intents',
  {
    checkoutIntentId: text('checkout_intent_id').primaryKey(),
    subscriptionId: text('subscription_id').notNull(),
    provider: text('provider').notNull(),
    providerCheckoutReference: text('provider_checkout_ref'),
    status: text('status').notNull(),
    createdAt: integer('created_at').notNull(),
    openedAt: integer('opened_at'),
  },
  (table) => [
    uniqueIndex('idx_billing_checkout_provider_ref').on(
      table.provider,
      table.providerCheckoutReference,
    ),
    index('idx_billing_checkout_subscription').on(
      table.subscriptionId,
      table.createdAt,
    ),
    foreignKey({
      columns: [table.subscriptionId],
      foreignColumns: [billingSubscriptions.subscriptionId],
      name: 'billing_checkout_subscription_fk',
    }).onDelete('cascade'),
    check(
      'billing_checkout_intents_shape_check',
      sql`${table.status} IN ('created', 'opened')
        AND ${table.createdAt} >= 0
        AND (
          (${table.status} = 'created' AND ${table.providerCheckoutReference} IS NULL AND ${table.openedAt} IS NULL)
          OR (${table.status} = 'opened' AND ${table.providerCheckoutReference} IS NOT NULL AND ${table.openedAt} >= ${table.createdAt})
        )`,
    ),
  ],
);

export const billingProviderEventReceipts = sqliteTable(
  'billing_provider_event_receipts',
  {
    provider: text('provider').notNull(),
    providerEventId: text('provider_event_id').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    factKind: text('fact_kind').notNull(),
    outcome: text('outcome').notNull(),
    occurredAt: integer('occurred_at').notNull(),
    appliedVersion: integer('applied_version').notNull(),
    recordedAt: integer('recorded_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.providerEventId] }),
    index('idx_billing_provider_events_subscription').on(
      table.subscriptionId,
      table.occurredAt,
      table.providerEventId,
    ),
    foreignKey({
      columns: [table.subscriptionId],
      foreignColumns: [billingSubscriptions.subscriptionId],
      name: 'billing_provider_events_subscription_fk',
    }).onDelete('cascade'),
    check(
      'billing_provider_events_shape_check',
      sql`${table.factKind} IN (
          'trial-started', 'payment-method-updated', 'invoice-paid',
          'invoice-payment-failed', 'invoice-payment-action-required',
          'cancellation-scheduled', 'subscription-cancelled'
        )
        AND ${table.outcome} IN ('applied', 'ignored')
        AND ${table.occurredAt} >= 0 AND ${table.appliedVersion} > 0
        AND ${table.recordedAt} >= 0`,
    ),
  ],
);

export const billingReconciliationCheckpoints = sqliteTable(
  'billing_reconciliation_checkpoints',
  {
    provider: text('provider').notNull(),
    snapshotId: text('snapshot_id').notNull(),
    subscriptionId: text('subscription_id').notNull(),
    observedAt: integer('observed_at').notNull(),
    appliedVersion: integer('applied_version').notNull(),
    recordedAt: integer('recorded_at').notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.provider, table.snapshotId] }),
    index('idx_billing_reconcile_subscription').on(
      table.subscriptionId,
      table.observedAt,
      table.snapshotId,
    ),
    foreignKey({
      columns: [table.subscriptionId],
      foreignColumns: [billingSubscriptions.subscriptionId],
      name: 'billing_reconcile_subscription_fk',
    }).onDelete('cascade'),
    check(
      'billing_reconcile_shape_check',
      sql`${table.observedAt} >= 0 AND ${table.appliedVersion} > 0 AND ${table.recordedAt} >= 0`,
    ),
  ],
);
