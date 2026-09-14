import { describe, expect, it } from 'vitest';
import {
  initialPrivacyRequestUiState,
  privacyRequestStatusPresentation,
  privacyRequestUiReducer,
  type PrivacyRequestUiRecord,
} from '@/lib/application/privacy-request-ui';

const submissionId = '01991f20-61d2-7000-8000-000000002601';

describe('privacy request UI pure state', () => {
  it('requires explicit deletion confirmation and ignores duplicate submission', () => {
    const selected = privacyRequestUiReducer(initialPrivacyRequestUiState, {
      type: 'request-kind-selected',
      requestKind: 'deletion',
    });
    expect(
      privacyRequestUiReducer(selected, {
        type: 'submission-requested',
        newSubmissionId: submissionId,
      }),
    ).toBe(selected);
    const confirmed = privacyRequestUiReducer(selected, {
      type: 'confirmation-requested',
    });
    const submitting = privacyRequestUiReducer(confirmed, {
      type: 'submission-requested',
      newSubmissionId: submissionId,
    });
    expect(submitting).toMatchObject({
      kind: 'submitting',
      command: { requestKind: 'deletion', submissionId },
    });
    expect(
      privacyRequestUiReducer(submitting, {
        type: 'submission-requested',
        newSubmissionId: '01991f20-61d2-7000-8000-000000002602',
      }),
    ).toBe(submitting);
  });

  it('reuses the same submission ID after a failed request', () => {
    const submitting = privacyRequestUiReducer(initialPrivacyRequestUiState, {
      type: 'submission-requested',
      newSubmissionId: submissionId,
    });
    const retry = privacyRequestUiReducer(submitting, {
      type: 'submission-failed',
      failure: 'unavailable',
    });
    expect(retry).toMatchObject({
      kind: 'draft',
      retrySubmissionId: submissionId,
      failure: 'unavailable',
    });
    expect(
      privacyRequestUiReducer(retry, {
        type: 'submission-requested',
        newSubmissionId: '01991f20-61d2-7000-8000-000000002602',
      }),
    ).toMatchObject({
      kind: 'submitting',
      command: { submissionId },
    });
  });

  it('accepts only correlated submit and refresh results and resets restored pages', () => {
    const submitting = privacyRequestUiReducer(initialPrivacyRequestUiState, {
      type: 'submission-requested',
      newSubmissionId: submissionId,
    });
    const wrongKind = privacyRequestUiReducer(submitting, {
      type: 'submission-accepted',
      request: record(undefined, { requestKind: 'correction' }),
    });
    expect(wrongKind).toMatchObject({
      kind: 'draft',
      failure: 'unavailable',
      retrySubmissionId: submissionId,
    });

    const tracking = privacyRequestUiReducer(submitting, {
      type: 'submission-accepted',
      request: record(),
    });
    const refreshing = privacyRequestUiReducer(tracking, {
      type: 'refresh-requested',
    });
    const mismatch = privacyRequestUiReducer(refreshing, {
      type: 'refresh-accepted',
      request: record(undefined, {
        requestId: '01991f20-61d2-7000-8000-000000002502',
      }),
    });
    expect(mismatch).toMatchObject({
      kind: 'tracking',
      refresh: 'idle',
      failure: 'unavailable',
    });
    expect(
      privacyRequestUiReducer(mismatch, { type: 'page-reentered' }),
    ).toEqual(initialPrivacyRequestUiState);
  });

  it('presents every public status without treating deletion handoff as completed deletion', () => {
    const presentations = [
      record({ status: 'verification-pending' }),
      record({ status: 'ready' }),
      record({ status: 'processing' }),
      record({ status: 'completed', outcome: 'fulfilled' }),
      record({ status: 'completed', outcome: 'account-deletion-started' }),
      record({ status: 'rejected' }),
      record({ status: 'failed', retryable: true }),
      record({ status: 'failed', retryable: false }),
    ].map(privacyRequestStatusPresentation);
    expect(presentations.map(({ label }) => label)).toEqual([
      '本人確認待ち',
      '本人確認済み・処理待ち',
      '処理中',
      '処理完了',
      '退会処理を開始済み',
      '受付後に不成立',
      '一時的に処理できません',
      '処理できません',
    ]);
    expect(presentations[4]?.detail).toContain('削除完了とは扱いません');
  });
});

type PrivacyRequestUiRecordState =
  | { readonly status: 'verification-pending' }
  | { readonly status: 'ready' }
  | { readonly status: 'processing' }
  | {
      readonly status: 'completed';
      readonly outcome: 'fulfilled' | 'account-deletion-started';
    }
  | { readonly status: 'rejected' }
  | { readonly status: 'failed'; readonly retryable: boolean };

function record(
  state: PrivacyRequestUiRecordState = { status: 'verification-pending' },
  baseOverride: Partial<
    Pick<PrivacyRequestUiRecord, 'requestId' | 'requestKind'>
  > = {},
): PrivacyRequestUiRecord {
  return {
    requestId: '01991f20-61d2-7000-8000-000000002501',
    requestKind: 'disclosure',
    requestedAt: 1_000,
    updatedAt: 1_000,
    ...baseOverride,
    ...state,
  };
}
