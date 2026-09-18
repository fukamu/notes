import { describe, expect, it } from 'vitest';
import {
  privacyRequestPublicStatus,
  privacyRequestStatusCommandDecoder,
  privacyRequestSubmitCommandDecoder,
} from '@/server/privacy-request/application-core';
import {
  planPrivacyRequestFailure,
  planPrivacyRequestProcessingStart,
  planPrivacyRequestVerification,
} from '@/server/privacy-request/core';
import {
  privacyRequestIds,
  privacyRequestRecord,
} from '@/tests/fixtures/privacy-request';

describe('privacy request application core', () => {
  it('accepts only the public command fields', () => {
    expect(
      privacyRequestSubmitCommandDecoder.decode({
        submissionId: privacyRequestIds.submissionA,
        requestKind: 'disclosure',
      }).ok,
    ).toBe(true);
    expect(
      privacyRequestSubmitCommandDecoder.decode({
        submissionId: privacyRequestIds.submissionA,
        requestKind: 'disclosure',
        accountId: 'caller-controlled',
      }).ok,
    ).toBe(false);
    expect(
      privacyRequestStatusCommandDecoder.decode({
        requestId: privacyRequestIds.requestA,
        vaultId: 'caller-controlled',
      }).ok,
    ).toBe(false);
  });

  it('redacts verification evidence and failure codes from public status', () => {
    const verified = planPrivacyRequestVerification({
      record: privacyRequestRecord(),
      decision: {
        kind: 'approved',
        receiptId: privacyRequestIds.verificationA,
        decidedAt: 1_100,
      },
    });
    if (verified.kind !== 'accepted') throw new Error('verification failed');
    const processing = planPrivacyRequestProcessingStart({
      record: verified.transition.next,
      startedAt: 1_200,
    });
    if (processing.kind !== 'accepted') throw new Error('start failed');
    const failed = planPrivacyRequestFailure({
      record: processing.transition.next,
      failedAt: 1_300,
      failureCode: privacyRequestIds.failureA,
      retryable: true,
    });
    if (failed.kind !== 'accepted') throw new Error('failure failed');

    const status = privacyRequestPublicStatus(failed.transition.next);
    expect(status).toEqual({
      requestId: privacyRequestIds.requestA,
      requestKind: 'disclosure',
      status: 'failed',
      retryable: true,
      requestedAt: 1_000,
      updatedAt: 1_300,
    });
    expect(JSON.stringify(status)).not.toMatch(
      /verification|receipt|failureCode|executor-unavailable/,
    );
  });
});
