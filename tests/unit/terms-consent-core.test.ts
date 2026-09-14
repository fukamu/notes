import { describe, expect, it } from 'vitest';
import {
  planTermsConsent,
  planTermsConsentSnapshot,
  serializeTermsDisclosure,
} from '@/server/terms-consent/core';
import { termsConsentCommandDecoder } from '@/server/terms-consent/public';
import { billingContext } from '@/tests/fixtures/billing';
import {
  termsConsentCommand,
  termsConsentIds,
  termsConsentRecord,
  termsDisclosure,
  termsSnapshot,
} from '@/tests/fixtures/terms-consent';

describe('terms consent pure core', () => {
  it('prepares a deterministic full disclosure snapshot without mutating input', () => {
    const disclosure = termsDisclosure();
    const before = JSON.stringify(disclosure);
    const plan = planTermsConsentSnapshot({
      disclosure,
      termsHash: termsConsentIds.hashA,
    });
    expect(plan).toMatchObject({
      kind: 'ready',
      snapshot: {
        termsVersion: 'terms-v1:2026-09-15',
        termsHash: termsConsentIds.hashA,
      },
    });
    if (plan.kind !== 'ready') throw new Error('missing terms snapshot');
    expect(plan.snapshot.serializedTerms).toBe(
      serializeTermsDisclosure(disclosure),
    );
    expect(JSON.stringify(disclosure)).toBe(before);
  });

  it('rejects malformed terms and commands without an explicit consent choice', () => {
    expect(
      planTermsConsentSnapshot({
        disclosure: { ...termsDisclosure(), termsVersion: 'terms-latest' },
        termsHash: termsConsentIds.hashA,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-terms' });
    expect(
      termsConsentCommandDecoder.decode({
        submissionId: termsConsentIds.submissionA,
        presentedTermsVersion: 'terms-v1:2026-09-15',
        presentedTermsHash: termsConsentIds.hashA,
      }).ok,
    ).toBe(false);
  });

  it('requires affirmative consent and the authoritative version and hash', () => {
    const base = {
      context: billingContext(),
      snapshot: termsSnapshot(),
      consentId: termsConsentIds.consentA,
      acceptedAt: 2_000,
      existing: undefined,
    } as const;
    expect(
      planTermsConsent({
        ...base,
        command: termsConsentCommand({
          consent: { kind: 'not-affirmed' },
        }),
      }),
    ).toEqual({ kind: 'rejected', reason: 'consent-required' });
    expect(
      planTermsConsent({
        ...base,
        command: termsConsentCommand({
          presentedTermsHash: termsConsentIds.hashB,
        }),
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale-terms' });
    expect(
      planTermsConsent({
        ...base,
        command: termsConsentCommand(),
        acceptedAt: -1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-command' });
  });

  it('appends once, replays the exact submission, and rejects changed evidence', () => {
    const command = termsConsentCommand();
    const base = {
      context: billingContext(),
      command,
      snapshot: termsSnapshot(),
      consentId: termsConsentIds.consentA,
      acceptedAt: 2_000,
    } as const;
    const append = planTermsConsent({ ...base, existing: undefined });
    expect(append.kind).toBe('append');
    if (append.kind !== 'append') throw new Error('missing append plan');
    expect(
      planTermsConsent({ ...base, existing: append.record }),
    ).toMatchObject({ kind: 'replay', record: append.record });

    const changedHashSnapshot = termsSnapshot('a', termsConsentIds.hashB);
    expect(
      planTermsConsent({
        ...base,
        command: {
          ...command,
          presentedTermsHash: termsConsentIds.hashB,
        },
        snapshot: changedHashSnapshot,
        existing: append.record,
      }),
    ).toEqual({ kind: 'rejected', reason: 'identifier-conflict' });

    const changedTextPlan = planTermsConsentSnapshot({
      disclosure: {
        ...termsDisclosure(),
        notices: '同じversion/hashでは置換できない変更済み文面',
      },
      termsHash: termsConsentIds.hashA,
    });
    if (changedTextPlan.kind !== 'ready') {
      throw new Error('missing changed terms snapshot');
    }
    expect(
      planTermsConsent({
        ...base,
        snapshot: changedTextPlan.snapshot,
        existing: append.record,
      }),
    ).toEqual({ kind: 'rejected', reason: 'identifier-conflict' });

    const changedVersionSnapshot = termsSnapshot('b');
    expect(
      planTermsConsent({
        ...base,
        command: {
          ...command,
          presentedTermsVersion: changedVersionSnapshot.termsVersion,
          presentedTermsHash: changedVersionSnapshot.termsHash,
        },
        snapshot: changedVersionSnapshot,
        existing: append.record,
      }),
    ).toEqual({ kind: 'rejected', reason: 'identifier-conflict' });
  });

  it('fails closed if a repository returns another Vault record', () => {
    expect(
      planTermsConsent({
        context: billingContext(),
        command: termsConsentCommand(),
        snapshot: termsSnapshot(),
        consentId: termsConsentIds.consentA,
        acceptedAt: 2_000,
        existing: termsConsentRecord({
          scope: {
            accountId: billingContext('b').accountId,
            vaultId: billingContext('b').vaultId,
          },
        }),
      }),
    ).toEqual({ kind: 'rejected', reason: 'owner-mismatch' });
  });
});
