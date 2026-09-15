import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { productionMigrationManifest } from '@/server/migrations/production';
import {
  vaultQuotaFinalizationAssertions,
  vaultQuotaReservations,
  vaultQuotaUsage,
} from '@/server/quota/d1-schema';
import {
  vaultQuotaLedgerMigration,
  vaultQuotaLedgerStatements,
} from '@/server/quota/migration';
import { dekRotationMigration } from '@/server/crypto/rotation-migration';

describe('Vault quota ledger schema', () => {
  it('scopes usage and reservations by Account and Vault', () => {
    const usage = getTableConfig(vaultQuotaUsage);
    expect(usage.columns.map((column) => column.name)).toEqual([
      'account_id',
      'vault_id',
      'revision',
      'active_cards',
      'plaintext_bytes',
      'last_transition_reservation_id',
      'created_at',
      'updated_at',
    ]);
    expect(usage.primaryKeys).toHaveLength(1);
    expect(usage.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'account_id',
      'vault_id',
    ]);
    expect(usage.foreignKeys.map((key) => key.getName())).toEqual([
      'vault_quota_usage_owner_fk',
    ]);

    const reservations = getTableConfig(vaultQuotaReservations);
    expect(reservations.primaryKeys).toHaveLength(1);
    expect(
      reservations.primaryKeys[0]?.columns.map((column) => column.name),
    ).toEqual(['account_id', 'vault_id', 'reservation_id']);
    expect(reservations.foreignKeys.map((key) => key.getName())).toEqual([
      'vault_quota_reservations_owner_fk',
    ]);
    expect(reservations.indexes.map((index) => index.config.name)).toEqual([
      'idx_vault_quota_reservations_reconcile',
    ]);
    expect(reservations.checks).toHaveLength(1);

    const assertions = getTableConfig(vaultQuotaFinalizationAssertions);
    expect(assertions.columns.map((column) => column.name)).toEqual([
      'account_id',
      'vault_id',
      'reservation_id',
      'assertion_passed',
    ]);
    expect(assertions.primaryKeys).toHaveLength(1);
    expect(
      assertions.primaryKeys[0]?.columns.map((column) => column.name),
    ).toEqual(['account_id', 'vault_id', 'reservation_id']);
    expect(assertions.foreignKeys.map((key) => key.getName())).toEqual([
      'vault_quota_finalization_assertions_owner_fk',
    ]);
    expect(assertions.checks.map((constraint) => constraint.name)).toEqual([
      'vault_quota_finalization_assertions_shape_check',
    ]);
  });

  it('checks in additive DDL and the finalization assertion table without content', async () => {
    const tableSource = await readFile(
      'drizzle/0012_gigantic_iron_lad.sql',
      'utf8',
    );
    const assertionSource = await readFile(
      'drizzle/0013_vault_quota_finalize_assertions.sql',
      'utf8',
    );
    for (const marker of [
      'vault_quota_usage',
      'vault_quota_reservations',
      'idx_vault_quota_reservations_reconcile',
    ]) {
      expect(tableSource).toContain(marker);
    }
    expect(assertionSource).toContain(
      'vault_quota_finalization_assertions_shape_check',
    );
    expect(assertionSource).toContain('assertion_passed = 1');
    expect(tableSource).not.toContain('CREATE TRIGGER');
    expect(assertionSource.trimStart()).toMatch(
      /^CREATE TABLE vault_quota_finalization_assertions/,
    );
    expect(assertionSource).not.toContain('CREATE TRIGGER');
    expect(assertionSource).not.toContain('CREATE INDEX');
    for (const excluded of [
      'title',
      'body_json',
      'ciphertext',
      'wrapped_dek',
      'token_hash',
      'provider_secret',
    ]) {
      expect(`${tableSource}\n${assertionSource}`.toLowerCase()).not.toContain(
        excluded,
      );
    }
  });

  it('pins the immutable manifest and appends it after existing migrations', () => {
    const checksum = createHash('sha256')
      .update(vaultQuotaLedgerStatements.join('\n'))
      .digest('hex');
    expect(vaultQuotaLedgerMigration.checksum).toBe(`sha256:${checksum}`);
    expect(vaultQuotaLedgerStatements.join('\n')).not.toContain(
      'CREATE TRIGGER',
    );
    expect(productionMigrationManifest.indexOf(vaultQuotaLedgerMigration)).toBe(
      productionMigrationManifest.indexOf(dekRotationMigration) + 1,
    );
  });
});
