import {
  localLegalTermsFixture,
  type LegalTermsDisclosure,
} from '@/lib/application/legal-terms';
import {
  planTermsConsentSnapshot,
  type TermsConsentSnapshotPlan,
} from '@/server/terms-consent/core';
import {
  parseTermsConsentId,
  parseTermsConsentSubmissionId,
  parseTermsDocumentHash,
  type TermsConsentCommand,
  type TermsConsentRecord,
  type TermsConsentSnapshot,
} from '@/server/terms-consent/public';
import { billingContext } from './billing';

export const termsConsentIds = {
  consentA: parseTermsConsentId('01991f20-61d2-7000-8000-000000002501'),
  consentB: parseTermsConsentId('01991f20-61d2-7000-8000-000000002502'),
  consentC: parseTermsConsentId('01991f20-61d2-7000-8000-000000002503'),
  consentD: parseTermsConsentId('01991f20-61d2-7000-8000-000000002504'),
  submissionA: parseTermsConsentSubmissionId(
    '01991f20-61d2-7000-8000-000000002601',
  ),
  submissionB: parseTermsConsentSubmissionId(
    '01991f20-61d2-7000-8000-000000002602',
  ),
  submissionC: parseTermsConsentSubmissionId(
    '01991f20-61d2-7000-8000-000000002603',
  ),
  submissionD: parseTermsConsentSubmissionId(
    '01991f20-61d2-7000-8000-000000002604',
  ),
  hashA: parseTermsDocumentHash(`sha256:${'a'.repeat(64)}`),
  hashB: parseTermsDocumentHash(`sha256:${'b'.repeat(64)}`),
} as const;

export function termsDisclosure(
  version: 'a' | 'b' = 'a',
): LegalTermsDisclosure {
  return version === 'a'
    ? localLegalTermsFixture
    : {
        ...localLegalTermsFixture,
        termsVersion: 'terms-v1:2026-09-16',
        effectiveDate: '2026-09-16',
      };
}

export function termsSnapshot(
  version: 'a' | 'b' = 'a',
  hash = version === 'a' ? termsConsentIds.hashA : termsConsentIds.hashB,
): TermsConsentSnapshot {
  const planned: TermsConsentSnapshotPlan = planTermsConsentSnapshot({
    disclosure: termsDisclosure(version),
    termsHash: hash,
  });
  if (planned.kind === 'rejected') {
    throw new Error('invalid terms consent fixture');
  }
  return planned.snapshot;
}

export function termsConsentCommand(
  overrides: Partial<TermsConsentCommand> = {},
): TermsConsentCommand {
  const snapshot = termsSnapshot();
  return {
    submissionId: termsConsentIds.submissionA,
    presentedTermsVersion: snapshot.termsVersion,
    presentedTermsHash: snapshot.termsHash,
    consent: { kind: 'affirmed' },
    ...overrides,
  };
}

export function termsConsentRecord(
  overrides: Partial<TermsConsentRecord> = {},
): TermsConsentRecord {
  return {
    scope: {
      accountId: billingContext().accountId,
      vaultId: billingContext().vaultId,
    },
    consentId: termsConsentIds.consentA,
    submissionId: termsConsentIds.submissionA,
    snapshot: termsSnapshot(),
    consent: 'affirmed',
    acceptedAt: 2_000,
    ...overrides,
  };
}
