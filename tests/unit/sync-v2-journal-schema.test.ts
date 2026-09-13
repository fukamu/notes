import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { productionMigrationManifest } from '@/server/migrations/production';
import { entitlementMigration } from '@/server/entitlement/migration';
import {
  vaultCardDisplayIds,
  vaultSyncV2Changes,
  vaultSyncV2Commits,
  vaultSyncV2States,
} from '@/server/vault-content/sync-v2-d1-schema';
import {
  syncV2JournalMigration,
  syncV2JournalStatements,
} from '@/server/vault-content/sync-v2-migration';

describe('Vault Sync v2 journal schema', () => {
  it('pins tenant-prefixed keys, the display uniqueness index, and foreign keys', () => {
    const contract = [
      {
        table: vaultSyncV2States,
        columns: 3,
        indexes: [],
        foreignKeys: 1,
        checks: 2,
      },
      {
        table: vaultCardDisplayIds,
        columns: 3,
        indexes: ['idx_vault_card_display_ids_official'],
        foreignKeys: 1,
        checks: 1,
      },
      {
        table: vaultSyncV2Commits,
        columns: 7,
        indexes: [],
        foreignKeys: 1,
        checks: 1,
      },
      {
        table: vaultSyncV2Changes,
        columns: 8,
        indexes: [],
        foreignKeys: 1,
        checks: 1,
      },
    ];
    for (const expected of contract) {
      const actual = getTableConfig(expected.table);
      expect(actual.columns).toHaveLength(expected.columns);
      expect(actual.indexes.map((index) => index.config.name)).toEqual(
        expected.indexes,
      );
      expect(actual.foreignKeys).toHaveLength(expected.foreignKeys);
      expect(actual.checks).toHaveLength(expected.checks);
    }
  });

  it('checks in the generated additive migration without content columns', async () => {
    const source = await readFile(
      'drizzle/0008_vault_sync_v2_journal.sql',
      'utf8',
    );
    for (const marker of [
      'vault_sync_v2_states',
      'vault_card_display_ids',
      'vault_sync_v2_commits',
      'vault_sync_v2_changes',
      'next_change_sequence',
      'fingerprint',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'title',
      'body_json',
      'plaintext',
      'ciphertext',
      'wrapped_dek',
      'stripe',
    ]) {
      expect(source.toLowerCase()).not.toContain(excluded);
    }
    expect(productionMigrationManifest).toContain(syncV2JournalMigration);
    expect(
      productionMigrationManifest.indexOf(syncV2JournalMigration),
    ).toBeGreaterThan(
      productionMigrationManifest.indexOf(entitlementMigration),
    );
  });

  it('pins immutable migration statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(syncV2JournalStatements.join('\n'))
      .digest('hex');
    expect(syncV2JournalMigration.checksum).toBe(`sha256:${checksum}`);
  });
});
