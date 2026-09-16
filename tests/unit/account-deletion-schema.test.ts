import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  accountDeletionContinuations,
  accountDeletionOperations,
  accountDeletionStepReceipts,
} from '@/server/account-deletion/d1-schema';
import {
  accountDeletionContinuationMigration,
  accountDeletionContinuationStatements,
} from '@/server/account-deletion/continuation-migration';
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

  it('adds only hash-based, operation-scoped continuation capability state', async () => {
    const continuations = getTableConfig(accountDeletionContinuations);
    expect(continuations.columns).toHaveLength(7);
    expect(continuations.indexes.map((index) => index.config.name)).toEqual([
      'idx_account_deletion_continuations_secret',
      'idx_account_deletion_continuations_expiry',
    ]);
    expect(continuations.foreignKeys).toHaveLength(1);
    expect(continuations.checks).toHaveLength(1);

    const source = await readFile(
      'drizzle/0010_account_deletion_continuation.sql',
      'utf8',
    );
    for (const marker of [
      'account_deletion_continuations',
      'idempotency_key_hash',
      'secret_hash',
      'expires_at',
      'sequence',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'continuation_token',
      'idempotency_key TEXT',
      'account_id',
      'vault_id',
      'provider',
      'plaintext',
    ]) {
      expect(source.toLowerCase()).not.toContain(excluded.toLowerCase());
    }
    expect(productionMigrationManifest).toContain(
      accountDeletionContinuationMigration,
    );
    expect(
      productionMigrationManifest.indexOf(accountDeletionContinuationMigration),
    ).toBeGreaterThan(
      productionMigrationManifest.indexOf(accountDeletionSagaMigration),
    );
  });

  it('pins the continuation migration statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(accountDeletionContinuationStatements.join('\n'))
      .digest('hex');
    expect(accountDeletionContinuationMigration.checksum).toBe(
      `sha256:${checksum}`,
    );
  });
});
