import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { contractEvidence } from '@/server/legal-checkout/d1-schema';
import {
  contractEvidenceMigration,
  contractEvidenceStatements,
} from '@/server/legal-checkout/migration';
import { productionMigrationManifest } from '@/server/migrations/production';
import { vaultQuotaLedgerMigration } from '@/server/quota/migration';

describe('contract evidence owned schema', () => {
  it('uses Vault-scoped keys, one submission index, and owner cascade', () => {
    const table = getTableConfig(contractEvidence);
    expect(table.columns.map((column) => column.name)).toEqual([
      'account_id',
      'vault_id',
      'evidence_id',
      'submission_id',
      'offer_hash',
      'offer_version',
      'disclosure_version',
      'serialized_offer',
      'consent',
      'confirmed_at',
    ]);
    expect(table.indexes.map((index) => index.config.name)).toEqual([
      'idx_contract_evidence_submission',
    ]);
    expect(table.foreignKeys).toHaveLength(1);
    expect(table.checks.map((check) => check.name)).toEqual([
      'contract_evidence_shape_check',
    ]);
  });

  it('keeps the Sites migration trigger-free and production evidence immutable', async () => {
    const source = await readFile('drizzle/0014_contract_evidence.sql', 'utf8');
    for (const marker of [
      'contract_evidence',
      'account_id, vault_id, evidence_id',
      'idx_contract_evidence_submission',
      'ON DELETE CASCADE',
    ]) {
      expect(source).toContain(marker);
    }
    expect(source).not.toMatch(/CREATE\s+TRIGGER/i);
    expect(contractEvidenceStatements.join('\n')).toContain(
      'CREATE TRIGGER contract_evidence_immutable',
    );
    for (const excluded of [
      'stripe',
      'card_number',
      'payment_method_payload',
      'client_secret',
    ]) {
      expect(source.toLowerCase()).not.toContain(excluded);
    }
    expect(productionMigrationManifest.indexOf(contractEvidenceMigration)).toBe(
      productionMigrationManifest.indexOf(vaultQuotaLedgerMigration) + 1,
    );
  });

  it('pins immutable migration statements to their SHA-256 checksum', () => {
    const checksum = createHash('sha256')
      .update(contractEvidenceStatements.join('\n'))
      .digest('hex');
    expect(contractEvidenceMigration.checksum).toBe(`sha256:${checksum}`);
  });
});
