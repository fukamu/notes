import {
  parsePrivacyRequestId,
  parsePrivacyRequestSubmissionId,
} from '@/lib/contracts/privacy-request';

export const privacyRequestIds = {
  requestA: parsePrivacyRequestId(
    '01991f20-61d2-7000-8000-000000002501',
  ),
  requestB: parsePrivacyRequestId(
    '01991f20-61d2-7000-8000-000000002502',
  ),
  submissionA: parsePrivacyRequestSubmissionId(
    '01991f20-61d2-7000-8000-000000002601',
  ),
} as const;
