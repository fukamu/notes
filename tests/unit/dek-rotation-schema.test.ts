import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { vaultDekRotationOperations } from '@/server/crypto/d1-schema';
import {
  dekRotationMigration,
  dekRotationStatements,
} from '@/server/crypto/rotation-migration';
import { productionMigrationManifest } from '@/server/migrations/production';

describe('DEK rotation schema', () => {
  it('binds one durable operation to its Account and Vault owner', () => {
    const table = getTableConfig(vaultDekRotationOperations);
    expect(table.columns.map((column) => column.name)).toEqual([
      'vault_id',
      'account_id',
      'operation_id',
      'revision',
      'source_version',
      'target_version',
      'state',
      'kek_key_reference',
      'wrapped_dek',
      'key_created_at',
      'created_at',
      'updated_at',
      'completed_at',
    ]);
    expect(table.primaryKeys).toHaveLength(0);
    expect(
      table.columns.find((column) => column.name === 'vault_id'),
    ).toMatchObject({ primary: true });
    expect(table.foreignKeys.map((key) => key.getName())).toEqual([
      'vault_dek_rotation_owner_fk',
    ]);
    expect(table.indexes.map((index) => index.config.name)).toEqual([
      'idx_vault_dek_rotation_operation',
      'idx_vault_dek_rotation_state',
    ]);
  });

  it('keeps the checked-in migration free of raw keys and plaintext', async () => {
    const source = await readFile('drizzle/0011_happy_lilith.sql', 'utf8');
    for (const marker of [
      'vault_dek_rotation_operations',
      'FOREIGN KEY (`account_id`,`vault_id`)',
      'idx_vault_dek_rotation_operation',
      'source_version',
      'target_version',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of ['raw_dek', 'key_bytes', 'plaintext', 'title']) {
      expect(source).not.toContain(excluded);
    }
  });

  it('pins the additive manifest and appends it after existing migrations', () => {
    const checksum = createHash('sha256')
      .update(dekRotationStatements.join('\n'))
      .digest('hex');
    expect(dekRotationMigration.checksum).toBe(`sha256:${checksum}`);
    expect(productionMigrationManifest.at(-1)).toBe(dekRotationMigration);
  });
});
