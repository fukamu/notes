import {
  parseTermsConsentId,
  parseTermsConsentSubmissionId,
  parseTermsDocumentHash,
} from '@/lib/contracts/terms-consent';

export const termsConsentIds = {
  consentA: parseTermsConsentId('01991f20-61d2-7000-8000-000000002501'),
  submissionA: parseTermsConsentSubmissionId(
    '01991f20-61d2-7000-8000-000000002601',
  ),
  hashA: parseTermsDocumentHash(`sha256:${'a'.repeat(64)}`),
} as const;
