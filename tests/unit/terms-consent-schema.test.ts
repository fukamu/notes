import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { productionMigrationManifest } from '@/server/migrations/production';
import { privacyRequestJournalMigration } from '@/server/privacy-request/migration';
import { termsConsentEvidence } from '@/server/terms-consent/d1-schema';
import {
  termsConsentLedgerMigration,
  termsConsentLedgerStatements,
} from '@/server/terms-consent/migration';

describe('terms consent ledger schema', () => {
  it('scopes every key and index to Account and Vault', () => {
    const table = getTableConfig(termsConsentEvidence);
    expect(table.columns.map((column) => column.name)).toEqual([
      'account_id',
      'vault_id',
      'consent_id',
      'submission_id',
      'terms_version',
      'terms_hash',
      'serialized_terms',
      'consent',
      'accepted_at',
    ]);
    expect(table.indexes.map((index) => index.config.name)).toEqual([
      'idx_terms_consent_submission',
      'idx_terms_consent_latest',
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
    expect(table.foreignKeys).toHaveLength(1);
    expect(table.checks.map((check) => check.name)).toEqual([
      'terms_consent_shape_check',
    ]);
  });

  it('adds an immutable empty-schema migration after privacy requests', async () => {
    const source = await readFile(
      'drizzle/0015_terms_consent_ledger.sql',
      'utf8',
    );
    for (const marker of [
      'PRIMARY KEY (account_id, vault_id, consent_id)',
      'idx_terms_consent_submission',
      'idx_terms_consent_latest',
      'terms_consent_immutable',
      "consent = 'affirmed'",
      'ON DELETE CASCADE',
    ]) {
      expect(source).toContain(marker);
    }
    for (const excluded of [
      'email_address',
      'card_title',
      'card_body',
      'session_token',
      'payment_method',
    ]) {
      expect(source.toLowerCase()).not.toContain(excluded);
    }
    expect(
      productionMigrationManifest.indexOf(termsConsentLedgerMigration),
    ).toBe(
      productionMigrationManifest.indexOf(privacyRequestJournalMigration) + 1,
    );
  });

  it('pins migration statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(termsConsentLedgerStatements.join('\n'))
      .digest('hex');
    expect(termsConsentLedgerMigration.checksum).toBe(`sha256:${checksum}`);
  });
});
