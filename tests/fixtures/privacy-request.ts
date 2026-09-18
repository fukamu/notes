import type { PrivacyRequestKind } from '@/lib/domain/privacy-request';
import { planPrivacyRequestStart } from '@/server/privacy-request/core';
import {
  parsePrivacyRequestFailureCode,
  parsePrivacyRequestId,
  parsePrivacyRequestSubmissionId,
  parsePrivacyRequestVerificationReceiptId,
  type PrivacyRequestRecord,
} from '@/server/privacy-request/public';
import { billingContext } from '@/tests/fixtures/billing';

export const privacyRequestIds = {
  requestA: parsePrivacyRequestId('01991f20-61d2-7000-8000-000000002501'),
  requestB: parsePrivacyRequestId('01991f20-61d2-7000-8000-000000002502'),
  requestC: parsePrivacyRequestId('01991f20-61d2-7000-8000-000000002503'),
  requestD: parsePrivacyRequestId('01991f20-61d2-7000-8000-000000002504'),
  submissionA: parsePrivacyRequestSubmissionId(
    '01991f20-61d2-7000-8000-000000002601',
  ),
  submissionB: parsePrivacyRequestSubmissionId(
    '01991f20-61d2-7000-8000-000000002602',
  ),
  submissionC: parsePrivacyRequestSubmissionId(
    '01991f20-61d2-7000-8000-000000002603',
  ),
  submissionD: parsePrivacyRequestSubmissionId(
    '01991f20-61d2-7000-8000-000000002604',
  ),
  verificationA: parsePrivacyRequestVerificationReceiptId(
    '01991f20-61d2-7000-8000-000000002701',
  ),
  verificationB: parsePrivacyRequestVerificationReceiptId(
    '01991f20-61d2-7000-8000-000000002702',
  ),
  failureA: parsePrivacyRequestFailureCode('executor-unavailable'),
} as const;

export function privacyRequestRecord(
  input: {
    readonly owner?: 'a' | 'b';
    readonly requestId?: typeof privacyRequestIds.requestA;
    readonly submissionId?: typeof privacyRequestIds.submissionA;
    readonly requestKind?: PrivacyRequestKind;
    readonly requestedAt?: number;
  } = {},
): PrivacyRequestRecord {
  const plan = planPrivacyRequestStart({
    scope: billingContext(input.owner),
    requestId: input.requestId ?? privacyRequestIds.requestA,
    submissionId: input.submissionId ?? privacyRequestIds.submissionA,
    requestKind: input.requestKind ?? 'disclosure',
    requestedAt: input.requestedAt ?? 1_000,
  });
  if (plan.kind !== 'accepted') {
    throw new Error('invalid privacy request fixture');
  }
  return plan.record;
}
