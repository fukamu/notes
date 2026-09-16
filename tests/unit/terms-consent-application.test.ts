import { describe, expect, it, vi } from 'vitest';
import {
  createTermsConsentApplication,
  type TermsConsentApplication,
} from '@/server/terms-consent/application';
import {
  createFakeTermsConsentModule,
  createFakeTermsConsentRepository,
  FakeCurrentTermsSource,
  FakeTermsDocumentHasher,
} from '@/server/terms-consent/fake';
import type { TermsConsentRepository } from '@/server/terms-consent/public';
import { createWebCryptoTermsDocumentHasher } from '@/server/terms-consent/web-crypto-hash';
import { billingContext } from '@/tests/fixtures/billing';
import {
  termsConsentCommand,
  termsConsentIds,
  termsConsentRecord,
  termsDisclosure,
  termsSnapshot,
} from '@/tests/fixtures/terms-consent';

describe('terms consent application', () => {
  it('reports current, records once, and replays the same submission', async () => {
    const consentModule = createFakeTermsConsentModule();
    await expect(
      consentModule.application.status({ context: billingContext() }),
    ).resolves.toMatchObject({
      kind: 'accepted',
      outcome: 'status',
      status: { kind: 'current', acceptanceRequired: true },
    });
    const input = {
      context: billingContext(),
      command: termsConsentCommand(),
      consentId: termsConsentIds.consentA,
      acceptedAt: 2_000,
    } as const;
    await expect(
      consentModule.application.accept(input),
    ).resolves.toMatchObject({
      kind: 'accepted',
      outcome: 'recorded',
      status: { kind: 'accepted', acceptanceRequired: false },
    });
    await expect(
      consentModule.application.accept(input),
    ).resolves.toMatchObject({
      kind: 'accepted',
      outcome: 'replayed',
      status: { kind: 'accepted' },
    });
    expect(consentModule.hasher.calls).toHaveLength(3);
  });

  it('uses only explicit legal review metadata for changed terms', async () => {
    const consentModule = createFakeTermsConsentModule();
    await acceptCurrent(consentModule.application);
    consentModule.hasher.set(termsConsentIds.hashB);
    consentModule.source.set({
      disclosure: termsDisclosure('b'),
      acceptancePolicy: { kind: 'undecided' },
    });
    await expect(
      consentModule.application.status({ context: billingContext() }),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'classification-required',
    });
    consentModule.source.set({
      disclosure: termsDisclosure('b'),
      acceptancePolicy: {
        kind: 'notice-only',
        legalReviewId: 'legal-review:2026-09-16',
      },
    });
    await expect(
      consentModule.application.status({ context: billingContext() }),
    ).resolves.toMatchObject({
      kind: 'accepted',
      status: { kind: 'notice-only', acceptanceRequired: false },
    });
    consentModule.source.set({
      disclosure: termsDisclosure('b'),
      acceptancePolicy: {
        kind: 'reconsent-required',
        legalReviewId: 'legal-review:2026-09-16-material',
      },
    });
    await expect(
      consentModule.application.status({ context: billingContext() }),
    ).resolves.toMatchObject({
      kind: 'accepted',
      status: { kind: 'reconsent-required', acceptanceRequired: true },
    });
  });

  it('rejects non-affirmative and stale commands before persistence', async () => {
    const append = vi.fn<TermsConsentRepository['append']>();
    const repository: TermsConsentRepository = {
      findById: async () => undefined,
      findBySubmission: async () => undefined,
      findLatest: async () => undefined,
      append,
    };
    const application = createTermsConsentApplication({
      repository,
      source: new FakeCurrentTermsSource({
        disclosure: termsDisclosure(),
        acceptancePolicy: { kind: 'initial-release' },
      }),
      hasher: new FakeTermsDocumentHasher(termsConsentIds.hashA),
    });
    await expect(
      application.accept({
        context: billingContext(),
        command: termsConsentCommand({ consent: { kind: 'not-affirmed' } }),
        consentId: termsConsentIds.consentA,
        acceptedAt: 2_000,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'consent-required' });
    await expect(
      application.accept({
        context: billingContext(),
        command: termsConsentCommand({
          presentedTermsHash: termsConsentIds.hashB,
        }),
        consentId: termsConsentIds.consentA,
        acceptedAt: 2_000,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'stale-terms' });
    expect(append).not.toHaveBeenCalled();
  });

  it('revalidates an insert race and rejects changed replay payloads', async () => {
    const existing = termsConsentRecord();
    const repository: TermsConsentRepository = {
      findById: async () => undefined,
      findBySubmission: async () => undefined,
      findLatest: async () => undefined,
      append: async () => ({ kind: 'existing', record: existing }),
    };
    const application = createTermsConsentApplication({
      repository,
      source: new FakeCurrentTermsSource({
        disclosure: termsDisclosure(),
        acceptancePolicy: { kind: 'initial-release' },
      }),
      hasher: new FakeTermsDocumentHasher(termsConsentIds.hashA),
    });
    await expect(
      application.accept({
        context: billingContext(),
        command: termsConsentCommand(),
        consentId: termsConsentIds.consentB,
        acceptedAt: 3_000,
      }),
    ).resolves.toMatchObject({ kind: 'accepted', outcome: 'replayed' });

    const changed = createTermsConsentApplication({
      repository,
      source: new FakeCurrentTermsSource({
        disclosure: termsDisclosure('b'),
        acceptancePolicy: {
          kind: 'reconsent-required',
          legalReviewId: 'legal-review:2026-09-16',
        },
      }),
      hasher: new FakeTermsDocumentHasher(termsConsentIds.hashB),
    });
    await expect(
      changed.accept({
        context: billingContext(),
        command: termsConsentCommand({
          presentedTermsVersion: termsSnapshot('b').termsVersion,
          presentedTermsHash: termsConsentIds.hashB,
        }),
        consentId: termsConsentIds.consentB,
        acceptedAt: 3_000,
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'identifier-conflict',
    });
  });

  it('fails closed for invalid sources, hashes, and repository failures', async () => {
    const repository = createFakeTermsConsentRepository();
    for (const application of [
      createTermsConsentApplication({
        repository,
        source: new FakeCurrentTermsSource({ disclosure: termsDisclosure() }),
        hasher: new FakeTermsDocumentHasher(termsConsentIds.hashA),
      }),
      createTermsConsentApplication({
        repository,
        source: new FakeCurrentTermsSource({
          disclosure: termsDisclosure(),
          acceptancePolicy: { kind: 'initial-release' },
        }),
        hasher: new FakeTermsDocumentHasher('not-a-hash'),
      }),
    ]) {
      await expect(
        application.status({ context: billingContext() }),
      ).resolves.toMatchObject({ kind: 'rejected' });
    }

    const failure: TermsConsentRepository = {
      findById: async () => undefined,
      findBySubmission: async () => {
        throw new Error('D1 unavailable');
      },
      findLatest: async () => {
        throw new Error('D1 unavailable');
      },
      append: async () => ({ kind: 'created' }),
    };
    const application = createTermsConsentApplication({
      repository: failure,
      source: new FakeCurrentTermsSource({
        disclosure: termsDisclosure(),
        acceptancePolicy: { kind: 'initial-release' },
      }),
      hasher: new FakeTermsDocumentHasher(termsConsentIds.hashA),
    });
    await expect(
      application.status({ context: billingContext() }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'unavailable' });
  });

  it('provides a Web Crypto SHA-256 adapter without runtime globals in core', async () => {
    const hash = await createWebCryptoTermsDocumentHasher(
      globalThis.crypto.subtle,
    ).hash('FUKAMU Notes terms');
    expect(hash).toMatch(/^sha256:[a-f0-9]{64}$/);
  });
});

async function acceptCurrent(application: TermsConsentApplication) {
  return application.accept({
    context: billingContext(),
    command: termsConsentCommand(),
    consentId: termsConsentIds.consentA,
    acceptedAt: 2_000,
  });
}
