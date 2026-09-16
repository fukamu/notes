import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { contractEvidenceMigration } from '@/server/legal-checkout/migration';
import { productionMigrationManifest } from '@/server/migrations/production';
import { privacyRequests } from '@/server/privacy-request/d1-schema';
import {
  privacyRequestJournalMigration,
  privacyRequestJournalStatements,
} from '@/server/privacy-request/migration';

describe('privacy request journal schema', () => {
  it('scopes every key and index to Account and Vault', () => {
    const table = getTableConfig(privacyRequests);
    expect(table.columns.map((column) => column.name)).toEqual([
      'account_id',
      'vault_id',
      'request_id',
      'submission_id',
      'request_kind',
      'revision',
      'state',
      'verification_receipt_id',
      'verified_at',
      'started_at',
      'completed_at',
      'outcome',
      'rejected_at',
      'rejection_reason',
      'failed_at',
      'failure_code',
      'retryable',
      'requested_at',
      'updated_at',
    ]);
    expect(table.indexes.map((index) => index.config.name)).toEqual([
      'idx_privacy_requests_submission',
      'idx_privacy_requests_state',
    ]);
    const accountId = table.columns.find(
      (column) => column.name === 'account_id',
    );
    const vaultId = table.columns.find((column) => column.name === 'vault_id');
    if (accountId === undefined || vaultId === undefined) {
      throw new Error('missing scope columns');
    }
    expect(
      table.indexes.every(
        (index) =>
          index.config.columns[0] === accountId &&
          index.config.columns[1] === vaultId,
      ),
    ).toBe(true);
    expect(table.foreignKeys).toHaveLength(0);
    expect(table.checks.map((check) => check.name)).toEqual([
      'privacy_requests_shape_check',
    ]);
  });

  it('adds an empty-schema migration after contract evidence', async () => {
    const source = await readFile(
      'drizzle/0015_privacy_request_journal.sql',
      'utf8',
    );
    for (const marker of [
      'PRIMARY KEY (account_id, vault_id, request_id)',
      'privacy_requests_shape_check',
      'idx_privacy_requests_submission',
      'idx_privacy_requests_state',
      'verification-pending',
      'account-deletion-started',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'email_address',
      'card_title',
      'card_body',
      'access_token',
      'secret',
    ]) {
      expect(source.toLowerCase()).not.toContain(excluded);
    }
    expect(
      productionMigrationManifest.indexOf(privacyRequestJournalMigration),
    ).toBe(productionMigrationManifest.indexOf(contractEvidenceMigration) + 1);
  });

  it('pins migration statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(privacyRequestJournalStatements.join('\n'))
      .digest('hex');
    expect(privacyRequestJournalMigration.checksum).toBe(`sha256:${checksum}`);
  });
});
