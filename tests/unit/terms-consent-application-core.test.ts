import { describe, expect, it } from 'vitest';
import {
  acceptedTermsStatus,
  decideTermsConsentStatus,
} from '@/server/terms-consent/application-core';
import { billingContext } from '@/tests/fixtures/billing';
import {
  termsConsentIds,
  termsConsentRecord,
  termsSnapshot,
} from '@/tests/fixtures/terms-consent';

describe('terms consent status pure policy', () => {
  it('requires the current terms when no evidence exists', () => {
    expect(
      decideTermsConsentStatus({
        context: billingContext(),
        current: termsSnapshot(),
        latest: undefined,
        acceptancePolicy: { kind: 'initial-release' },
      }),
    ).toMatchObject({
      kind: 'resolved',
      status: {
        kind: 'current',
        acceptanceRequired: true,
        current: { termsVersion: 'terms-v1:2026-09-15' },
      },
    });
  });

  it('recognizes evidence only when version, hash, and snapshot are current', () => {
    const current = termsSnapshot();
    const record = termsConsentRecord();
    expect(
      decideTermsConsentStatus({
        context: billingContext(),
        current,
        latest: record,
        acceptancePolicy: { kind: 'undecided' },
      }),
    ).toEqual(acceptedTermsStatus({ current, record }));
    expect(acceptedTermsStatus({ current, record })).toMatchObject({
      kind: 'resolved',
      status: {
        kind: 'accepted',
        acceptanceRequired: false,
        accepted: { consentId: termsConsentIds.consentA, acceptedAt: 2_000 },
      },
    });
  });

  it.each([
    [
      { kind: 'reconsent-required', legalReviewId: 'legal-review:2026-09-16' },
      'reconsent-required',
      true,
    ],
    [
      { kind: 'notice-only', legalReviewId: 'legal-review:2026-09-16' },
      'notice-only',
      false,
    ],
  ] as const)(
    'uses explicit legal metadata %s for an older accepted version',
    (acceptancePolicy, kind, acceptanceRequired) => {
      expect(
        decideTermsConsentStatus({
          context: billingContext(),
          current: termsSnapshot('b'),
          latest: termsConsentRecord(),
          acceptancePolicy,
        }),
      ).toMatchObject({
        kind: 'resolved',
        status: { kind, acceptanceRequired },
      });
    },
  );

  it.each([{ kind: 'initial-release' }, { kind: 'undecided' }] as const)(
    'does not infer a change classification from %s',
    (acceptancePolicy) => {
      expect(
        decideTermsConsentStatus({
          context: billingContext(),
          current: termsSnapshot('b'),
          latest: termsConsentRecord(),
          acceptancePolicy,
        }),
      ).toEqual({ kind: 'rejected', reason: 'classification-required' });
    },
  );

  it('fails closed for cross-Vault or silently replaced evidence', () => {
    expect(
      decideTermsConsentStatus({
        context: billingContext('b'),
        current: termsSnapshot(),
        latest: termsConsentRecord(),
        acceptancePolicy: { kind: 'initial-release' },
      }),
    ).toEqual({ kind: 'rejected', reason: 'owner-mismatch' });
    expect(
      decideTermsConsentStatus({
        context: billingContext(),
        current: termsSnapshot('a', termsConsentIds.hashB),
        latest: termsConsentRecord(),
        acceptancePolicy: {
          kind: 'reconsent-required',
          legalReviewId: 'legal-review:replacement',
        },
      }),
    ).toEqual({ kind: 'rejected', reason: 'inconsistent-evidence' });
  });
});
