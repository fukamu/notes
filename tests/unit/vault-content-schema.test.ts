import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  vaultCards,
  vaultConflicts,
  vaultMutationReceipts,
  vaultPartitionMappings,
} from '@/server/vault-content/d1-schema';
import {
  vaultContentMigration,
  vaultContentStatements,
} from '@/server/vault-content/migration';

describe('Vault content schema', () => {
  it('includes VaultId in every content primary key and secondary index', () => {
    const contract = [
      {
        table: vaultPartitionMappings,
        indexes: [
          'idx_vault_partition_mappings_owner',
          'idx_vault_partition_mappings_partition_vault',
        ],
        foreignKeys: 0,
      },
      {
        table: vaultCards,
        indexes: ['idx_vault_cards_updated'],
        foreignKeys: 1,
      },
      {
        table: vaultMutationReceipts,
        indexes: ['idx_vault_mutation_receipts_card'],
        foreignKeys: 1,
      },
      {
        table: vaultConflicts,
        indexes: ['idx_vault_conflicts_card'],
        foreignKeys: 1,
      },
    ];
    for (const expected of contract) {
      const actual = getTableConfig(expected.table);
      expect(actual.indexes.map((index) => index.config.name)).toEqual(
        expected.indexes,
      );
      for (const index of actual.indexes) {
        expect(
          index.config.columns.some(
            (column) => 'name' in column && column.name === 'vault_id',
          ),
        ).toBe(true);
      }
      expect(actual.foreignKeys).toHaveLength(expected.foreignKeys);
    }

    for (const table of [vaultCards, vaultMutationReceipts, vaultConflicts]) {
      const primaryKey = getTableConfig(table).primaryKeys[0];
      expect(primaryKey?.columns[0]?.name).toBe('vault_id');
    }
  });

  it('keeps the generated migration scoped to routing and content indexes', async () => {
    const source = await readFile('drizzle/0003_late_nighthawk.sql', 'utf8');
    for (const marker of [
      'vault_partition_mappings',
      'vault_cards',
      'vault_mutation_receipts',
      'vault_conflicts',
      'PRIMARY KEY(`vault_id`, `card_id`)',
      'idx_vault_partition_mappings_partition_vault',
      'idx_vault_cards_updated',
      'idx_vault_mutation_receipts_card',
      'idx_vault_conflicts_card',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'title',
      'body_json',
      'ciphertext',
      'wrapped_dek',
      'billing',
    ]) {
      expect(source).not.toContain(excluded);
    }
  });

  it('pins the immutable manifest statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(vaultContentStatements.join('\n'))
      .digest('hex');
    expect(vaultContentMigration.checksum).toBe(`sha256:${checksum}`);
  });
});
