import { describe, expect, it } from 'vitest';
import { billingContext } from '@/tests/fixtures/billing';
import {
  termsConsentCommand,
  termsConsentIds,
  termsConsentRecord,
  termsDisclosure,
} from '@/tests/fixtures/terms-consent';
import { createTermsConsentCheckoutVerifier } from '@/server/terms-consent/checkout-verifier';
import {
  createFakeTermsConsentModule,
  FakeTermsDocumentHasher,
  FakeCurrentTermsSource,
} from '@/server/terms-consent/fake';
import { createTermsConsentApplication } from '@/server/terms-consent/application';
import type { TermsConsentRepository } from '@/server/terms-consent/public';

describe('terms consent checkout verifier', () => {
  it('requires the same current submission and accepts it after immutable recording', async () => {
    const consentModule = createFakeTermsConsentModule();
    const verifier = createTermsConsentCheckoutVerifier({
      application: consentModule.application,
      repository: consentModule.repository,
    });
    const input = {
      context: billingContext(),
      submissionId: termsConsentIds.submissionA,
    } as const;
    await expect(verifier.verify(input)).resolves.toEqual({
      kind: 'rejected',
      reason: 'terms-consent-required',
    });
    await consentModule.application.accept({
      context: billingContext(),
      command: termsConsentCommand(),
      consentId: termsConsentIds.consentA,
      acceptedAt: 2_000,
    });
    await expect(verifier.verify(input)).resolves.toEqual({
      kind: 'accepted',
      consentId: termsConsentIds.consentA,
    });
    await expect(
      verifier.verify({ ...input, submissionId: termsConsentIds.submissionB }),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'terms-consent-required',
    });
  });

  it('rejects a recorded submission after the current terms change', async () => {
    const consentModule = createFakeTermsConsentModule();
    await consentModule.application.accept({
      context: billingContext(),
      command: termsConsentCommand(),
      consentId: termsConsentIds.consentA,
      acceptedAt: 2_000,
    });
    consentModule.source.set({
      disclosure: termsDisclosure('b'),
      acceptancePolicy: {
        kind: 'reconsent-required',
        legalReviewId: 'legal-review:2026-09-16',
      },
    });
    consentModule.hasher.set(termsConsentIds.hashB);
    const verifier = createTermsConsentCheckoutVerifier({
      application: consentModule.application,
      repository: consentModule.repository,
    });
    await expect(
      verifier.verify({
        context: billingContext(),
        submissionId: termsConsentIds.submissionA,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'terms-changed' });
  });

  it('fails closed for cross-tenant and unavailable repository values', async () => {
    const crossTenantRepository: TermsConsentRepository = {
      findById: async () => undefined,
      findLatest: async () => termsConsentRecord(),
      findBySubmission: async () => termsConsentRecord(),
      append: async () => ({ kind: 'created' }),
    };
    const application = createTermsConsentApplication({
      source: new FakeCurrentTermsSource({
        disclosure: termsDisclosure(),
        acceptancePolicy: { kind: 'initial-release' },
      }),
      hasher: new FakeTermsDocumentHasher(termsConsentIds.hashA),
      repository: crossTenantRepository,
    });
    const verifier = createTermsConsentCheckoutVerifier({
      application,
      repository: crossTenantRepository,
    });
    await expect(
      verifier.verify({
        context: billingContext('b'),
        submissionId: termsConsentIds.submissionA,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'owner-mismatch' });

    const unavailable: TermsConsentRepository = {
      ...crossTenantRepository,
      findBySubmission: async () => {
        throw new Error('D1 unavailable');
      },
    };
    await expect(
      createTermsConsentCheckoutVerifier({
        application,
        repository: unavailable,
      }).verify({
        context: billingContext(),
        submissionId: termsConsentIds.submissionA,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'unavailable' });
  });
});
