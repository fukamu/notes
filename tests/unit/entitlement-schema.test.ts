import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { billingSubscriptionMigration } from '@/server/billing/migration';
import {
  entitlementOfflineLeases,
  entitlementProjections,
} from '@/server/entitlement/d1-schema';
import {
  entitlementMigration,
  entitlementStatements,
} from '@/server/entitlement/migration';
import { productionMigrationManifest } from '@/server/migrations/production';

describe('Entitlement-owned schema', () => {
  it('owns projection and offline lease tables with tenant and expiry indexes', () => {
    const contract = [
      {
        table: entitlementProjections,
        columns: 11,
        indexes: ['idx_entitlement_projection_state'],
        foreignKeys: 1,
      },
      {
        table: entitlementOfflineLeases,
        columns: 12,
        indexes: [
          'idx_entitlement_leases_owner',
          'idx_entitlement_leases_expiry',
        ],
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

  it('checks in an additive provider-neutral migration after Billing', async () => {
    const source = await readFile('drizzle/0007_special_shadowcat.sql', 'utf8');
    for (const marker of [
      'entitlement_projections',
      'entitlement_offline_leases',
      'source_billing_version',
      'payment-action-required',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'stripe',
      'card_number',
      'allow_all',
      'free_plan',
    ]) {
      expect(source.toLowerCase()).not.toContain(excluded);
    }
    expect(productionMigrationManifest).toContain(entitlementMigration);
    expect(
      productionMigrationManifest.indexOf(entitlementMigration),
    ).toBeGreaterThan(
      productionMigrationManifest.indexOf(billingSubscriptionMigration),
    );
  });

  it('pins immutable migration statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(entitlementStatements.join('\n'))
      .digest('hex');
    expect(entitlementMigration.checksum).toBe(`sha256:${checksum}`);
  });
});
