import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  accountDeletionOperations,
  accountDeletionStepReceipts,
} from '@/server/account-deletion/d1-schema';
import {
  accountDeletionSagaMigration,
  accountDeletionSagaStatements,
} from '@/server/account-deletion/migration';
import { productionMigrationManifest } from '@/server/migrations/production';
import { syncV2JournalMigration } from '@/server/vault-content/sync-v2-migration';

describe('account deletion saga schema', () => {
  it('keeps durable operations and receipts in feature-owned tables without an Account FK', () => {
    const operations = getTableConfig(accountDeletionOperations);
    expect(operations.columns).toHaveLength(13);
    expect(operations.indexes.map((index) => index.config.name)).toEqual([
      'idx_account_deletion_operations_account',
      'idx_account_deletion_operations_ready',
    ]);
    expect(operations.foreignKeys).toHaveLength(0);
    expect(operations.checks).toHaveLength(1);

    const receipts = getTableConfig(accountDeletionStepReceipts);
    expect(receipts.columns).toHaveLength(3);
    expect(receipts.indexes).toHaveLength(0);
    expect(receipts.foreignKeys).toHaveLength(1);
    expect(receipts.checks).toHaveLength(1);
  });

  it('checks in the generated additive migration without user content or provider data', async () => {
    const source = await readFile(
      'drizzle/0009_account_deletion_saga.sql',
      'utf8',
    );
    for (const marker of [
      'account_deletion_operations',
      'account_deletion_step_receipts',
      'revoke-sessions',
      'idx_account_deletion_operations_ready',
      'lease_expires_at',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'title',
      'body_json',
      'plaintext',
      'ciphertext',
      'wrapped_dek',
      'token_hash',
      'provider_secret',
      'stripe',
    ]) {
      expect(source.toLowerCase()).not.toContain(excluded);
    }
    expect(productionMigrationManifest).toContain(accountDeletionSagaMigration);
    expect(
      productionMigrationManifest.indexOf(accountDeletionSagaMigration),
    ).toBeGreaterThan(
      productionMigrationManifest.indexOf(syncV2JournalMigration),
    );
  });

  it('pins immutable migration statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(accountDeletionSagaStatements.join('\n'))
      .digest('hex');
    expect(accountDeletionSagaMigration.checksum).toBe(`sha256:${checksum}`);
  });
});
