import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { vaultDekVersions } from '@/server/crypto/d1-schema';
import {
  envelopeEncryptionMetadataMigration,
  envelopeEncryptionMetadataStatements,
} from '@/server/crypto/migration';

describe('Envelope encryption metadata schema', () => {
  it('stores wrapped DEK metadata under a Vault-scoped primary key', () => {
    const table = getTableConfig(vaultDekVersions);
    expect(table.columns.map((column) => column.name)).toEqual([
      'vault_id',
      'dek_version',
      'kek_key_reference',
      'wrapped_dek',
      'is_write_key',
      'created_at',
    ]);
    expect(table.primaryKeys[0]?.columns.map((column) => column.name)).toEqual([
      'vault_id',
      'dek_version',
    ]);
    expect(table.indexes.map((index) => index.config.name)).toEqual([
      'idx_vault_dek_versions_write',
      'idx_vault_dek_versions_created',
    ]);
    for (const index of table.indexes) {
      expect(index.config.columns[0]).toMatchObject({ name: 'vault_id' });
    }
  });

  it('keeps the generated migration limited to wrapped-key metadata', async () => {
    const source = await readFile('drizzle/0004_known_wind_dancer.sql', 'utf8');
    for (const marker of [
      'vault_dek_versions',
      'PRIMARY KEY(`vault_id`, `dek_version`)',
      'kek_key_reference',
      'wrapped_dek',
      'idx_vault_dek_versions_write',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'plaintext',
      'raw_dek',
      'key_bytes',
      'title',
      'body_json',
    ]) {
      expect(source).not.toContain(excluded);
    }
  });

  it('pins the immutable manifest statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(envelopeEncryptionMetadataStatements.join('\n'))
      .digest('hex');
    expect(envelopeEncryptionMetadataMigration.checksum).toBe(
      `sha256:${checksum}`,
    );
  });
});
