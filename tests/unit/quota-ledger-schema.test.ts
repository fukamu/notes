import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { productionMigrationManifest } from '@/server/migrations/production';
import {
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
  });

  it('checks in additive DDL and the atomic finalization trigger without content', async () => {
    const source = await readFile('drizzle/0012_gigantic_iron_lad.sql', 'utf8');
    for (const marker of [
      'vault_quota_usage',
      'vault_quota_reservations',
      'idx_vault_quota_reservations_reconcile',
      'vault_quota_finalize_usage',
      'BEFORE UPDATE OF state',
      'RAISE(IGNORE)',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'title',
      'body_json',
      'ciphertext',
      'wrapped_dek',
      'token_hash',
      'provider_secret',
    ]) {
      expect(source.toLowerCase()).not.toContain(excluded);
    }
  });

  it('pins the immutable manifest and appends it after existing migrations', () => {
    const checksum = createHash('sha256')
      .update(vaultQuotaLedgerStatements.join('\n'))
      .digest('hex');
    expect(vaultQuotaLedgerMigration.checksum).toBe(`sha256:${checksum}`);
    expect(productionMigrationManifest.indexOf(vaultQuotaLedgerMigration)).toBe(
      productionMigrationManifest.indexOf(dekRotationMigration) + 1,
    );
  });
});
