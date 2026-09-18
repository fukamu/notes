import { describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import {
  isPrivacyRequestKind,
  privacyRequestKinds,
} from '@/lib/domain/privacy-request';
import {
  isValidPrivacyRequest,
  isValidPrivacyRequestTransition,
  planPrivacyRequestCompletion,
  planPrivacyRequestFailure,
  planPrivacyRequestProcessingStart,
  planPrivacyRequestRetry,
  planPrivacyRequestStart,
  planPrivacyRequestVerification,
} from '@/server/privacy-request/core';
import {
  parsePrivacyRequestFailureCode,
  parsePrivacyRequestId,
} from '@/server/privacy-request/public';
import { billingContext } from '@/tests/fixtures/billing';
import {
  privacyRequestIds,
  privacyRequestRecord,
} from '@/tests/fixtures/privacy-request';

describe('privacy request pure state', () => {
  it('creates a verification-pending request without reading effects', () => {
    expect(
      planPrivacyRequestStart({
        scope: billingContext(),
        requestId: privacyRequestIds.requestA,
        submissionId: privacyRequestIds.submissionA,
        requestKind: 'disclosure',
        requestedAt: 1_000,
      }),
    ).toEqual({ kind: 'accepted', record: privacyRequestRecord() });
    expect(
      planPrivacyRequestStart({
        scope: billingContext(),
        requestId: privacyRequestIds.requestA,
        submissionId: privacyRequestIds.submissionA,
        requestKind: 'disclosure',
        requestedAt: -1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-timestamp' });
  });

  it('requires verification before processing and completes non-delete requests', () => {
    const pending = privacyRequestRecord();
    expect(
      planPrivacyRequestProcessingStart({ record: pending, startedAt: 1_100 }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-state' });

    const verification = planPrivacyRequestVerification({
      record: pending,
      decision: {
        kind: 'approved',
        receiptId: privacyRequestIds.verificationA,
        decidedAt: 1_100,
      },
    });
    if (verification.kind !== 'accepted')
      throw new Error('verification failed');
    const processing = planPrivacyRequestProcessingStart({
      record: verification.transition.next,
      startedAt: 1_200,
    });
    if (processing.kind !== 'accepted') throw new Error('start failed');
    const completion = planPrivacyRequestCompletion({
      record: processing.transition.next,
      completedAt: 1_300,
      outcome: 'fulfilled',
    });
    expect(completion).toMatchObject({
      kind: 'accepted',
      transition: {
        next: {
          revision: 4,
          state: { kind: 'completed', outcome: 'fulfilled' },
          updatedAt: 1_300,
        },
      },
    });
    if (completion.kind !== 'accepted') throw new Error('completion failed');
    expect(isValidPrivacyRequest(completion.transition.next)).toBe(true);
    expect(
      planPrivacyRequestCompletion({
        record: completion.transition.next,
        completedAt: 1_400,
        outcome: 'fulfilled',
      }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-state' });
  });

  it('allows account-deletion outcome only for a deletion request', () => {
    const ready = planPrivacyRequestVerification({
      record: privacyRequestRecord({ requestKind: 'deletion' }),
      decision: {
        kind: 'approved',
        receiptId: privacyRequestIds.verificationA,
        decidedAt: 1_100,
      },
    });
    if (ready.kind !== 'accepted') throw new Error('verification failed');
    const processing = planPrivacyRequestProcessingStart({
      record: ready.transition.next,
      startedAt: 1_200,
    });
    if (processing.kind !== 'accepted') throw new Error('start failed');
    expect(
      planPrivacyRequestCompletion({
        record: processing.transition.next,
        completedAt: 1_300,
        outcome: 'fulfilled',
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-outcome' });
    expect(
      planPrivacyRequestCompletion({
        record: processing.transition.next,
        completedAt: 1_300,
        outcome: 'account-deletion-started',
      }),
    ).toMatchObject({
      kind: 'accepted',
      transition: {
        next: {
          state: {
            kind: 'completed',
            outcome: 'account-deletion-started',
          },
        },
      },
    });
  });

  it('records a redacted failure and retries only retryable work', () => {
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
    expect(
      planPrivacyRequestRetry({
        record: failed.transition.next,
        retriedAt: 1_400,
      }),
    ).toMatchObject({
      kind: 'accepted',
      transition: { next: { state: { kind: 'ready' }, updatedAt: 1_400 } },
    });

    const terminal = planPrivacyRequestFailure({
      record: processing.transition.next,
      failedAt: 1_300,
      failureCode: privacyRequestIds.failureA,
      retryable: false,
    });
    if (terminal.kind !== 'accepted') throw new Error('failure failed');
    expect(
      planPrivacyRequestRetry({
        record: terminal.transition.next,
        retriedAt: 1_400,
      }),
    ).toEqual({ kind: 'rejected', reason: 'not-retryable' });
  });

  it('rejects identity-verification failure and tenant/timeline tampering', () => {
    const pending = privacyRequestRecord();
    expect(
      planPrivacyRequestVerification({
        record: pending,
        decision: {
          kind: 'rejected',
          reason: 'identity-not-verified',
          decidedAt: 999,
        },
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-timestamp' });
    expect(
      planPrivacyRequestVerification({
        record: pending,
        decision: {
          kind: 'rejected',
          reason: 'identity-not-verified',
          decidedAt: 1_100,
        },
      }),
    ).toMatchObject({
      kind: 'accepted',
      transition: {
        next: {
          state: {
            kind: 'rejected',
            reason: 'identity-not-verified',
          },
        },
      },
    });

    const valid = planPrivacyRequestVerification({
      record: pending,
      decision: {
        kind: 'approved',
        receiptId: privacyRequestIds.verificationA,
        decidedAt: 1_100,
      },
    });
    if (valid.kind !== 'accepted') throw new Error('verification failed');
    expect(
      isValidPrivacyRequestTransition(billingContext('b'), valid.transition),
    ).toBe(false);
    expect(
      isValidPrivacyRequest({
        ...valid.transition.next,
        updatedAt: 1_050,
      }),
    ).toBe(false);
  });

  it('decodes only UUIDv7 identifiers and non-sensitive failure codes', () => {
    expect(() => parsePrivacyRequestId('not-a-uuid')).toThrow(
      BoundaryDecodeError,
    );
    expect(() => parsePrivacyRequestFailureCode('Contains Secret')).toThrow(
      BoundaryDecodeError,
    );
    expect(parsePrivacyRequestId(privacyRequestIds.requestA)).toBe(
      privacyRequestIds.requestA,
    );
    expect(privacyRequestKinds.every(isPrivacyRequestKind)).toBe(true);
    expect(isPrivacyRequestKind('export-everything')).toBe(false);
  });
});
