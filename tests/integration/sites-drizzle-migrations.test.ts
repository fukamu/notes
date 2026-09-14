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
  it('applies every checked-in migration as one prepared statement per breakpoint', async () => {
    const schema = await database
      .prepare(
        `SELECT type, name FROM sqlite_schema
         WHERE name IN (
           'contract_evidence',
           'idx_contract_evidence_submission',
           'contract_evidence_immutable',
           'privacy_requests',
           'idx_privacy_requests_submission',
           'idx_privacy_requests_state',
           'terms_consent_evidence',
           'idx_terms_consent_submission',
           'idx_terms_consent_latest',
           'terms_consent_immutable'
         )
         ORDER BY name`,
      )
      .all<{ name: string; type: string }>();

    expect(schema.results).toEqual([
      { name: 'contract_evidence', type: 'table' },
      { name: 'contract_evidence_immutable', type: 'trigger' },
      { name: 'idx_contract_evidence_submission', type: 'index' },
      { name: 'idx_privacy_requests_state', type: 'index' },
      { name: 'idx_privacy_requests_submission', type: 'index' },
      { name: 'idx_terms_consent_latest', type: 'index' },
      { name: 'idx_terms_consent_submission', type: 'index' },
      { name: 'privacy_requests', type: 'table' },
      { name: 'terms_consent_evidence', type: 'table' },
      { name: 'terms_consent_immutable', type: 'trigger' },
    ]);
  });

  it('keeps trigger bodies intact and immutable evidence enforced', async () => {
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

    await expect(
      database
        .prepare(
          'UPDATE contract_evidence SET confirmed_at = 3 WHERE evidence_id = ?',
        )
        .bind('01991f20-61d2-7000-8000-000000000003')
        .run(),
    ).rejects.toThrow(/immutable/);
    await expect(
      database
        .prepare(
          `UPDATE terms_consent_evidence
           SET accepted_at = 3 WHERE consent_id = ?`,
        )
        .bind('01991f20-61d2-7000-8000-000000000005')
        .run(),
    ).rejects.toThrow(/immutable/);
  });
});
