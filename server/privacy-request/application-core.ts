import { objectDecoder, type Decoder } from '../../lib/codec/core';
import type { PrivacyRequestKind } from '../../lib/domain/privacy-request';
import {
  privacyRequestIdDecoder,
  privacyRequestKindDecoder,
  privacyRequestSubmissionIdDecoder,
  type PrivacyRequestId,
  type PrivacyRequestOutcome,
  type PrivacyRequestRecord,
  type PrivacyRequestSubmissionId,
} from './public';

export type PrivacyRequestSubmitCommand = {
  readonly submissionId: PrivacyRequestSubmissionId;
  readonly requestKind: PrivacyRequestKind;
};

export type PrivacyRequestStatusCommand = {
  readonly requestId: PrivacyRequestId;
};

export const privacyRequestSubmitCommandDecoder: Decoder<PrivacyRequestSubmitCommand> =
  objectDecoder({
    submissionId: privacyRequestSubmissionIdDecoder,
    requestKind: privacyRequestKindDecoder,
  });

export const privacyRequestStatusCommandDecoder: Decoder<PrivacyRequestStatusCommand> =
  objectDecoder({ requestId: privacyRequestIdDecoder });

type PrivacyRequestPublicBase = {
  readonly requestId: PrivacyRequestId;
  readonly requestKind: PrivacyRequestKind;
  readonly requestedAt: number;
  readonly updatedAt: number;
};

export type PrivacyRequestPublicStatus = PrivacyRequestPublicBase &
  (
    | { readonly status: 'verification-pending' }
    | { readonly status: 'ready' }
    | { readonly status: 'processing' }
    | { readonly status: 'completed'; readonly outcome: PrivacyRequestOutcome }
    | { readonly status: 'rejected' }
    | { readonly status: 'failed'; readonly retryable: boolean }
  );

export function privacyRequestPublicStatus(
  record: PrivacyRequestRecord,
): PrivacyRequestPublicStatus {
  const base: PrivacyRequestPublicBase = {
    requestId: record.requestId,
    requestKind: record.requestKind,
    requestedAt: record.requestedAt,
    updatedAt: record.updatedAt,
  };
  switch (record.state.kind) {
    case 'verification-pending':
      return { ...base, status: 'verification-pending' };
    case 'ready':
      return { ...base, status: 'ready' };
    case 'processing':
      return { ...base, status: 'processing' };
    case 'completed':
      return {
        ...base,
        status: 'completed',
        outcome: record.state.outcome,
      };
    case 'rejected':
      return { ...base, status: 'rejected' };
    case 'failed':
      return {
        ...base,
        status: 'failed',
        retryable: record.state.retryable,
      };
  }
}
