import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  billingCheckoutIntents,
  billingProviderEventReceipts,
  billingReconciliationCheckpoints,
  billingSubscriptions,
} from '@/server/billing/d1-schema';
import {
  billingSubscriptionMigration,
  billingSubscriptionStatements,
} from '@/server/billing/migration';

describe('Billing-owned schema', () => {
  it('keeps subscription, checkout, receipt, and reconciliation data in feature-owned tables', () => {
    const contract = [
      {
        table: billingSubscriptions,
        columns: 26,
        indexes: [
          'idx_billing_subscriptions_owner',
          'idx_billing_subscriptions_customer',
          'idx_billing_subscriptions_provider_subscription',
          'idx_billing_subscriptions_status',
        ],
        foreignKeys: 1,
      },
      {
        table: billingCheckoutIntents,
        columns: 7,
        indexes: [
          'idx_billing_checkout_provider_ref',
          'idx_billing_checkout_subscription',
        ],
        foreignKeys: 1,
      },
      {
        table: billingProviderEventReceipts,
        columns: 8,
        indexes: ['idx_billing_provider_events_subscription'],
        foreignKeys: 1,
      },
      {
        table: billingReconciliationCheckpoints,
        columns: 6,
        indexes: ['idx_billing_reconcile_subscription'],
        foreignKeys: 1,
      },
    ];
    for (const expected of contract) {
      const actual = getTableConfig(expected.table);
      expect(actual.columns).toHaveLength(expected.columns);
      expect(actual.indexes.map((index) => index.config.name)).toEqual(
        expected.indexes,
      );
      expect(actual.foreignKeys).toHaveLength(expected.foreignKeys);
      expect(actual.checks).toHaveLength(1);
    }
  });

  it('keeps the checked-in migration provider-neutral and free of card data', async () => {
    const source = await readFile('drizzle/0006_narrow_vapor.sql', 'utf8');
    for (const marker of [
      'billing_subscriptions',
      'billing_checkout_intents',
      'billing_provider_event_receipts',
      'billing_reconciliation_checkpoints',
      'provider_subscription_ref',
      'invoice-payment-action-required',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'stripe',
      'card_number',
      'payment_method_payload',
      'webhook_payload',
      'client_secret',
    ]) {
      expect(source.toLowerCase()).not.toContain(excluded);
    }
  });

  it('pins immutable migration statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(billingSubscriptionStatements.join('\n'))
      .digest('hex');
    expect(billingSubscriptionMigration.checksum).toBe(`sha256:${checksum}`);
  });
});
