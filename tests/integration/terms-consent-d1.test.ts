import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { D1TermsConsentRepository } from '@/server/terms-consent/d1-adapter';
import { billingContext } from '@/tests/fixtures/billing';
import { personalAccountProvision } from '@/tests/fixtures/control-plane';
import {
  termsConsentIds,
  termsConsentRecord,
  termsSnapshot,
} from '@/tests/fixtures/terms-consent';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

let miniflare: Miniflare;
let database: TestDatabase;
let repository: D1TermsConsentRepository;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['TERMS_CONSENT'],
  });
  database = await miniflare.getD1Database('TERMS_CONSENT');
  expect(
    await runD1Migrations({
      database,
      manifest: productionMigrationManifest,
      appliedAt: 1_000,
    }),
  ).toMatchObject({ kind: 'applied' });
  await database.prepare('PRAGMA foreign_keys = ON').run();
  const controlPlane = new D1IdentityVaultControlPlane(database);
  await controlPlane.provisionPersonalAccount(personalAccountProvision('a'));
  await controlPlane.provisionPersonalAccount(personalAccountProvision('b'));
  repository = new D1TermsConsentRepository(database);
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('D1 terms consent repository', () => {
  it('records, replays, orders, and isolates evidence by Account and Vault', async () => {
    const first = termsConsentRecord();
    await expect(repository.append(billingContext(), first)).resolves.toEqual({
      kind: 'created',
    });
    await expect(repository.append(billingContext(), first)).resolves.toEqual({
      kind: 'existing',
      record: first,
    });
    await expect(
      repository.append(billingContext('b'), first),
    ).resolves.toEqual({ kind: 'rejected', reason: 'owner-mismatch' });

    const sameIdentifiersOtherVault = termsConsentRecord({
      scope: {
        accountId: billingContext('b').accountId,
        vaultId: billingContext('b').vaultId,
      },
    });
    await expect(
      repository.append(billingContext('b'), sameIdentifiersOtherVault),
    ).resolves.toEqual({ kind: 'created' });

    const latest = termsConsentRecord({
      consentId: termsConsentIds.consentB,
      submissionId: termsConsentIds.submissionB,
      snapshot: termsSnapshot('b'),
      acceptedAt: 3_000,
    });
    await expect(repository.append(billingContext(), latest)).resolves.toEqual({
      kind: 'created',
    });
    await expect(repository.findLatest(billingContext())).resolves.toEqual(
      latest,
    );
    await expect(
      repository.findById(billingContext('b'), termsConsentIds.consentB),
    ).resolves.toBeUndefined();
  });

  it('distinguishes a concurrent exact replay from a second insert', async () => {
    const raced = termsConsentRecord({
      scope: {
        accountId: billingContext('b').accountId,
        vaultId: billingContext('b').vaultId,
      },
      consentId: termsConsentIds.consentD,
      submissionId: termsConsentIds.submissionD,
      acceptedAt: 2_500,
    });
    const results = await Promise.all([
      repository.append(billingContext('b'), raced),
      repository.append(billingContext('b'), raced),
    ]);
    expect(results.map((result) => result.kind).sort()).toEqual([
      'created',
      'existing',
    ]);
  });

  it('rejects identifier collisions, unknown owners, and evidence updates', async () => {
    await expect(
      repository.append(
        billingContext(),
        termsConsentRecord({ submissionId: termsConsentIds.submissionC }),
      ),
    ).resolves.toEqual({ kind: 'conflict' });

    await expect(
      database
        .prepare(
          `INSERT INTO terms_consent_evidence(
            account_id, vault_id, consent_id, submission_id, terms_version,
            terms_hash, serialized_terms, consent, accepted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'affirmed', ?)`,
        )
        .bind(
          '01991f20-61d2-7000-8000-000000009901',
          '01991f20-61d2-7000-8000-000000009902',
          termsConsentIds.consentC,
          termsConsentIds.submissionC,
          termsSnapshot().termsVersion,
          termsSnapshot().termsHash,
          termsSnapshot().serializedTerms,
          3_100,
        )
        .run(),
    ).rejects.toThrow();

    await expect(
      database
        .prepare(
          `UPDATE terms_consent_evidence SET accepted_at = accepted_at + 1
           WHERE account_id = ? AND vault_id = ?`,
        )
        .bind(billingContext().accountId, billingContext().vaultId)
        .run(),
    ).rejects.toThrow(/immutable/);
  });

  it('decodes stored values from unknown and fails closed on malformed rows', async () => {
    await database.prepare('PRAGMA ignore_check_constraints = ON').run();
    await database
      .prepare(
        `INSERT INTO terms_consent_evidence(
          account_id, vault_id, consent_id, submission_id, terms_version,
          terms_hash, serialized_terms, consent, accepted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'affirmed', ?)`,
      )
      .bind(
        billingContext('b').accountId,
        billingContext('b').vaultId,
        termsConsentIds.consentC,
        termsConsentIds.submissionC,
        termsSnapshot().termsVersion,
        termsSnapshot().termsHash,
        'not-json',
        3_200,
      )
      .run();
    await database.prepare('PRAGMA ignore_check_constraints = OFF').run();
    await expect(
      repository.findBySubmission(
        billingContext('b'),
        termsConsentIds.submissionC,
      ),
    ).rejects.toBeInstanceOf(BoundaryDecodeError);
  });

  it('removes live consent evidence with the owning personal Vault', async () => {
    await database
      .prepare(
        'DELETE FROM personal_vaults WHERE account_id = ? AND vault_id = ?',
      )
      .bind(billingContext().accountId, billingContext().vaultId)
      .run();
    await expect(
      repository.findBySubmission(
        billingContext(),
        termsConsentIds.submissionA,
      ),
    ).resolves.toBeUndefined();
    await expect(
      repository.findLatest(billingContext()),
    ).resolves.toBeUndefined();
  });
});
