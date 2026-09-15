import { readFile, readdir } from 'node:fs/promises';
import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

let miniflare: Miniflare;
let database: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['SITES_MIGRATIONS'],
  });
  database = await miniflare.getD1Database('SITES_MIGRATIONS');

  const migrationFiles = (await readdir('drizzle'))
    .filter((file) => /^\d{4}_.+\.sql$/.test(file))
    .sort();
  for (const migrationFile of migrationFiles) {
    const source = await readFile(`drizzle/${migrationFile}`, 'utf8');
    for (const statement of source.split('--> statement-breakpoint')) {
      if (statement.trim() !== '') {
        await database.prepare(statement).run();
      }
    }
  }
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('ChatGPT Sites Drizzle migration compatibility', () => {
  it('registers every checked-in migration in the Drizzle journal', async () => {
    const migrationFiles = (await readdir('drizzle'))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();
    const journal = await readFile('drizzle/meta/_journal.json', 'utf8');

    for (const migrationFile of migrationFiles) {
      expect(journal).toContain(
        `"tag": "${migrationFile.replace(/\.sql$/, '')}"`,
      );
    }
  });

  it('keeps every Sites migration free of trigger statements', async () => {
    const migrationFiles = (await readdir('drizzle'))
      .filter((file) => /^\d{4}_.+\.sql$/.test(file))
      .sort();

    for (const migrationFile of migrationFiles) {
      const source = await readFile(`drizzle/${migrationFile}`, 'utf8');
      expect(source, migrationFile).not.toMatch(/CREATE\s+TRIGGER/i);
    }
  });

  it('keeps the quota finalization assertion table in one trigger-free migration statement', async () => {
    const source = await readFile(
      'drizzle/0013_vault_quota_finalize_assertions.sql',
      'utf8',
    );
    const statements = source
      .split('--> statement-breakpoint')
      .filter((statement) => statement.trim() !== '');

    expect(statements).toHaveLength(1);
    expect(statements[0]?.trimStart()).toMatch(
      /^CREATE TABLE vault_quota_finalization_assertions/,
    );
    expect(source).not.toContain('CREATE TRIGGER');
    expect(source).not.toContain('CREATE INDEX');
  });

  it('applies every checked-in migration as one prepared statement per breakpoint', async () => {
    const schema = await database
      .prepare(
        `SELECT type, name FROM sqlite_schema
         WHERE name IN (
           'contract_evidence',
           'vault_quota_finalization_assertions',
           'idx_contract_evidence_submission',
           'privacy_requests',
           'idx_privacy_requests_submission',
           'idx_privacy_requests_state',
           'terms_consent_evidence',
           'idx_terms_consent_submission',
           'idx_terms_consent_latest'
         )
         ORDER BY name`,
      )
      .all<{ name: string; type: string }>();

    expect(schema.results).toEqual([
      { name: 'contract_evidence', type: 'table' },
      { name: 'idx_contract_evidence_submission', type: 'index' },
      { name: 'idx_privacy_requests_state', type: 'index' },
      { name: 'idx_privacy_requests_submission', type: 'index' },
      { name: 'idx_terms_consent_latest', type: 'index' },
      { name: 'idx_terms_consent_submission', type: 'index' },
      { name: 'privacy_requests', type: 'table' },
      { name: 'terms_consent_evidence', type: 'table' },
      { name: 'vault_quota_finalization_assertions', type: 'table' },
    ]);
  });

  it('keeps legal evidence owner-scoped and preserves account deletion cascade', async () => {
    await database
      .prepare('INSERT INTO accounts(account_id, created_at) VALUES (?, ?)')
      .bind('01991f20-61d2-7000-8000-000000000001', 1)
      .run();
    await database
      .prepare(
        `INSERT INTO personal_vaults(vault_id, account_id, created_at)
         VALUES (?, ?, ?)`,
      )
      .bind(
        '01991f20-61d2-7000-8000-000000000002',
        '01991f20-61d2-7000-8000-000000000001',
        1,
      )
      .run();

    await database
      .prepare(
        `INSERT INTO contract_evidence(
           account_id, vault_id, evidence_id, submission_id, offer_hash,
           offer_version, disclosure_version, serialized_offer, consent,
           confirmed_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'affirmed', ?)`,
      )
      .bind(
        '01991f20-61d2-7000-8000-000000000001',
        '01991f20-61d2-7000-8000-000000000002',
        '01991f20-61d2-7000-8000-000000000003',
        '01991f20-61d2-7000-8000-000000000004',
        `sha256:${'a'.repeat(64)}`,
        'offer-v1',
        '2026-09-15',
        '{}',
        2,
      )
      .run();
    await database
      .prepare(
        `INSERT INTO terms_consent_evidence(
           account_id, vault_id, consent_id, submission_id, terms_version,
           terms_hash, serialized_terms, consent, accepted_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, 'affirmed', ?)`,
      )
      .bind(
        '01991f20-61d2-7000-8000-000000000001',
        '01991f20-61d2-7000-8000-000000000002',
        '01991f20-61d2-7000-8000-000000000005',
        '01991f20-61d2-7000-8000-000000000006',
        'terms-v1:2026-09-15',
        `sha256:${'b'.repeat(64)}`,
        '{}',
        2,
      )
      .run();

    await database
      .prepare(
        `DELETE FROM personal_vaults
         WHERE account_id = ? AND vault_id = ?`,
      )
      .bind(
        '01991f20-61d2-7000-8000-000000000001',
        '01991f20-61d2-7000-8000-000000000002',
      )
      .run();
    const remaining = await database
      .prepare(
        `SELECT
           (SELECT count(*) FROM contract_evidence) AS contracts,
           (SELECT count(*) FROM terms_consent_evidence) AS consents`,
      )
      .first<{ consents: number; contracts: number }>();
    expect(remaining).toEqual({ consents: 0, contracts: 0 });
  });
});
