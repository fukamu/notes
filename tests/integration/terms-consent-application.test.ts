import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { createTermsConsentApplication } from '@/server/terms-consent/application';
import { D1TermsConsentRepository } from '@/server/terms-consent/d1-adapter';
import { FakeCurrentTermsSource } from '@/server/terms-consent/fake';
import { createWebCryptoTermsDocumentHasher } from '@/server/terms-consent/web-crypto-hash';
import { billingContext } from '@/tests/fixtures/billing';
import { personalAccountProvision } from '@/tests/fixtures/control-plane';
import {
  termsConsentIds,
  termsDisclosure,
} from '@/tests/fixtures/terms-consent';

let miniflare: Miniflare;
let source: FakeCurrentTermsSource;
let application: ReturnType<typeof createTermsConsentApplication>;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['TERMS_CONSENT_APPLICATION'],
  });
  const database = await miniflare.getD1Database('TERMS_CONSENT_APPLICATION');
  await runD1Migrations({
    database,
    manifest: productionMigrationManifest,
    appliedAt: 900,
  });
  await database.prepare('PRAGMA foreign_keys = ON').run();
  const controlPlane = new D1IdentityVaultControlPlane(database);
  await controlPlane.provisionPersonalAccount(personalAccountProvision('a'));
  await controlPlane.provisionPersonalAccount(personalAccountProvision('b'));
  source = new FakeCurrentTermsSource({
    disclosure: termsDisclosure(),
    acceptancePolicy: { kind: 'initial-release' },
  });
  application = createTermsConsentApplication({
    source,
    hasher: createWebCryptoTermsDocumentHasher(globalThis.crypto.subtle),
    repository: new D1TermsConsentRepository(database),
  });
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('terms consent application with D1', () => {
  it('records and replays the authoritative current document per Vault', async () => {
    const current = await application.status({ context: billingContext() });
    expect(current).toMatchObject({
      kind: 'accepted',
      status: { kind: 'current', acceptanceRequired: true },
    });
    if (current.kind !== 'accepted') throw new Error('missing current terms');
    const command = {
      submissionId: termsConsentIds.submissionA,
      presentedTermsVersion: current.status.current.termsVersion,
      presentedTermsHash: current.status.current.termsHash,
      consent: { kind: 'affirmed' as const },
    };
    const input = {
      context: billingContext(),
      command,
      consentId: termsConsentIds.consentA,
      acceptedAt: 1_000,
    } as const;
    await expect(application.accept(input)).resolves.toMatchObject({
      kind: 'accepted',
      outcome: 'recorded',
      status: { kind: 'accepted' },
    });
    await expect(
      application.accept({ ...input, consentId: termsConsentIds.consentB }),
    ).resolves.toMatchObject({
      kind: 'accepted',
      outcome: 'replayed',
      status: { accepted: { consentId: termsConsentIds.consentA } },
    });
    await expect(
      application.status({ context: billingContext() }),
    ).resolves.toMatchObject({
      kind: 'accepted',
      status: { kind: 'accepted', acceptanceRequired: false },
    });
    await expect(
      application.status({ context: billingContext('b') }),
    ).resolves.toMatchObject({
      kind: 'accepted',
      status: { kind: 'current', acceptanceRequired: true },
    });
  });

  it('fails undecided changes closed, then applies explicit material policy', async () => {
    source.set({
      disclosure: termsDisclosure('b'),
      acceptancePolicy: { kind: 'undecided' },
    });
    await expect(
      application.status({ context: billingContext() }),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'classification-required',
    });

    source.set({
      disclosure: termsDisclosure('b'),
      acceptancePolicy: {
        kind: 'reconsent-required',
        legalReviewId: 'legal-review:2026-09-16',
      },
    });
    const required = await application.status({ context: billingContext() });
    expect(required).toMatchObject({
      kind: 'accepted',
      status: { kind: 'reconsent-required', acceptanceRequired: true },
    });
    if (required.kind !== 'accepted') throw new Error('missing current terms');
    await expect(
      application.accept({
        context: billingContext(),
        command: {
          submissionId: termsConsentIds.submissionB,
          presentedTermsVersion: required.status.current.termsVersion,
          presentedTermsHash: required.status.current.termsHash,
          consent: { kind: 'affirmed' },
        },
        consentId: termsConsentIds.consentB,
        acceptedAt: 2_000,
      }),
    ).resolves.toMatchObject({
      kind: 'accepted',
      outcome: 'recorded',
      status: { kind: 'accepted', acceptanceRequired: false },
    });
  });
});
