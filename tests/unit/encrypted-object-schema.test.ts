import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  vaultEncryptedObjects,
  vaultEncryptedWriteIntents,
  vaultObjectDeleteOutbox,
} from '@/server/encrypted-object/d1-schema';
import {
  encryptedObjectRepositoryMigration,
  encryptedObjectRepositoryStatements,
} from '@/server/encrypted-object/migration';

describe('encrypted object repository schema', () => {
  it('prefixes every primary and secondary key with VaultId', () => {
    const contract = [
      {
        table: vaultEncryptedObjects,
        primary: ['vault_id', 'object_type', 'object_id', 'object_revision'],
        indexes: [
          'idx_vault_encrypted_objects_write',
          'idx_vault_encrypted_objects_key',
          'idx_vault_encrypted_objects_current',
        ],
      },
      {
        table: vaultEncryptedWriteIntents,
        primary: ['vault_id', 'write_id'],
        indexes: [
          'idx_vault_encrypted_write_intents_target',
          'idx_vault_encrypted_write_intents_key',
        ],
      },
      {
        table: vaultObjectDeleteOutbox,
        primary: ['vault_id', 'object_key'],
        indexes: ['idx_vault_object_delete_outbox_ready'],
      },
    ];
    for (const expected of contract) {
      const table = getTableConfig(expected.table);
      expect(
        table.primaryKeys[0]?.columns.map((column) => column.name),
      ).toEqual(expected.primary);
      expect(table.indexes.map((index) => index.config.name)).toEqual(
        expected.indexes,
      );
      for (const index of table.indexes) {
        expect(index.config.columns[0]).toMatchObject({ name: 'vault_id' });
      }
    }
  });

  it('stores only encrypted-object metadata, intents, and delete work', async () => {
    const source = await readFile('drizzle/0005_tiny_chat.sql', 'utf8');
    for (const marker of [
      'vault_encrypted_objects',
      'vault_encrypted_write_intents',
      'vault_object_delete_outbox',
      'crypto_version',
      'dek_version',
      'ciphertext_bytes',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'title',
      'body_json',
      'sealed_payload',
      'nonce',
      'raw_dek',
      'key_bytes',
    ]) {
      expect(source).not.toContain(excluded);
    }
  });

  it('pins the immutable manifest statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(encryptedObjectRepositoryStatements.join('\n'))
      .digest('hex');
    expect(encryptedObjectRepositoryMigration.checksum).toBe(
      `sha256:${checksum}`,
    );
  });
});
