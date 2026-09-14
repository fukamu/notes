import { assertNever } from '../../lib/shared/invariant';
import {
  privacyRequestRevisionDecoder,
  type PrivacyRequestFailureCode,
  type PrivacyRequestOutcome,
  type PrivacyRequestRecord,
  type PrivacyRequestRejectionReason,
  type PrivacyRequestScope,
  type PrivacyRequestState,
  type PrivacyRequestTransition,
  type PrivacyRequestVerificationReceiptId,
} from './public';
import type { PrivacyRequestId, PrivacyRequestSubmissionId } from './public';
import type { PrivacyRequestKind } from '../../lib/domain/privacy-request';

export type PrivacyRequestStartPlan =
  | { readonly kind: 'accepted'; readonly record: PrivacyRequestRecord }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-timestamp' };

export type PrivacyRequestTransitionPlan =
  | { readonly kind: 'accepted'; readonly transition: PrivacyRequestTransition }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-outcome'
        | 'invalid-timestamp'
        | 'not-retryable'
        | 'revision-limit'
        | 'wrong-state';
    };

export type PrivacyRequestVerificationDecision =
  | {
      readonly kind: 'approved';
      readonly receiptId: PrivacyRequestVerificationReceiptId;
      readonly decidedAt: number;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: PrivacyRequestRejectionReason;
      readonly decidedAt: number;
    };

export function planPrivacyRequestStart(input: {
  readonly scope: PrivacyRequestScope;
  readonly requestId: PrivacyRequestId;
  readonly submissionId: PrivacyRequestSubmissionId;
  readonly requestKind: PrivacyRequestKind;
  readonly requestedAt: number;
}): PrivacyRequestStartPlan {
  if (!validTimestamp(input.requestedAt)) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  const revision = decodeRevision(1);
  if (revision === undefined) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  return {
    kind: 'accepted',
    record: {
      accountId: input.scope.accountId,
      vaultId: input.scope.vaultId,
      requestId: input.requestId,
      submissionId: input.submissionId,
      requestKind: input.requestKind,
      revision,
      state: { kind: 'verification-pending' },
      requestedAt: input.requestedAt,
      updatedAt: input.requestedAt,
    },
  };
}

export function planPrivacyRequestVerification(input: {
  readonly record: PrivacyRequestRecord;
  readonly decision: PrivacyRequestVerificationDecision;
}): PrivacyRequestTransitionPlan {
  if (input.record.state.kind !== 'verification-pending') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (!validEventTimestamp(input.record, input.decision.decidedAt)) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  switch (input.decision.kind) {
    case 'approved':
      return advance(
        input.record,
        {
          kind: 'ready',
          verificationReceiptId: input.decision.receiptId,
          verifiedAt: input.decision.decidedAt,
        },
        input.decision.decidedAt,
      );
    case 'rejected':
      return advance(
        input.record,
        {
          kind: 'rejected',
          rejectedAt: input.decision.decidedAt,
          reason: input.decision.reason,
        },
        input.decision.decidedAt,
      );
    default:
      return assertNever(
        input.decision,
        'Unsupported privacy request verification decision',
      );
  }
}

export function planPrivacyRequestProcessingStart(input: {
  readonly record: PrivacyRequestRecord;
  readonly startedAt: number;
}): PrivacyRequestTransitionPlan {
  const state = input.record.state;
  if (state.kind !== 'ready') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (!validEventTimestamp(input.record, input.startedAt)) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  return advance(
    input.record,
    {
      kind: 'processing',
      verificationReceiptId: state.verificationReceiptId,
      verifiedAt: state.verifiedAt,
      startedAt: input.startedAt,
    },
    input.startedAt,
  );
}

export function planPrivacyRequestCompletion(input: {
  readonly record: PrivacyRequestRecord;
  readonly completedAt: number;
  readonly outcome: PrivacyRequestOutcome;
}): PrivacyRequestTransitionPlan {
  const state = input.record.state;
  if (state.kind !== 'processing') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (!validEventTimestamp(input.record, input.completedAt)) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  if (!outcomeMatchesKind(input.record.requestKind, input.outcome)) {
    return { kind: 'rejected', reason: 'invalid-outcome' };
  }
  return advance(
    input.record,
    {
      kind: 'completed',
      verificationReceiptId: state.verificationReceiptId,
      verifiedAt: state.verifiedAt,
      startedAt: state.startedAt,
      completedAt: input.completedAt,
      outcome: input.outcome,
    },
    input.completedAt,
  );
}

export function planPrivacyRequestFailure(input: {
  readonly record: PrivacyRequestRecord;
  readonly failedAt: number;
  readonly failureCode: PrivacyRequestFailureCode;
  readonly retryable: boolean;
}): PrivacyRequestTransitionPlan {
  const state = input.record.state;
  if (state.kind !== 'processing') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (!validEventTimestamp(input.record, input.failedAt)) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  return advance(
    input.record,
    {
      kind: 'failed',
      verificationReceiptId: state.verificationReceiptId,
      verifiedAt: state.verifiedAt,
      startedAt: state.startedAt,
      failedAt: input.failedAt,
      failureCode: input.failureCode,
      retryable: input.retryable,
    },
    input.failedAt,
  );
}

export function planPrivacyRequestRetry(input: {
  readonly record: PrivacyRequestRecord;
  readonly retriedAt: number;
}): PrivacyRequestTransitionPlan {
  const state = input.record.state;
  if (state.kind !== 'failed') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (!state.retryable) {
    return { kind: 'rejected', reason: 'not-retryable' };
  }
  if (!validEventTimestamp(input.record, input.retriedAt)) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  return advance(
    input.record,
    {
      kind: 'ready',
      verificationReceiptId: state.verificationReceiptId,
      verifiedAt: state.verifiedAt,
    },
    input.retriedAt,
  );
}

export function isInitialPrivacyRequest(record: PrivacyRequestRecord): boolean {
  return (
    isValidPrivacyRequest(record) &&
    record.revision === 1 &&
    record.state.kind === 'verification-pending' &&
    record.updatedAt === record.requestedAt
  );
}

export function isValidPrivacyRequest(record: PrivacyRequestRecord): boolean {
  if (
    decodeRevision(record.revision) === undefined ||
    !validTimestamp(record.requestedAt) ||
    !validTimestamp(record.updatedAt) ||
    record.updatedAt < record.requestedAt
  ) {
    return false;
  }
  const state = record.state;
  switch (state.kind) {
    case 'verification-pending':
      return record.revision === 1 && record.updatedAt === record.requestedAt;
    case 'ready':
      return validVerifiedTimeline(record, state);
    case 'processing':
      return (
        validVerifiedTimeline(record, state) &&
        state.startedAt >= state.verifiedAt &&
        state.startedAt === record.updatedAt
      );
    case 'completed':
      return (
        validVerifiedTimeline(record, state) &&
        state.startedAt >= state.verifiedAt &&
        state.completedAt >= state.startedAt &&
        state.completedAt === record.updatedAt &&
        outcomeMatchesKind(record.requestKind, state.outcome)
      );
    case 'rejected':
      return (
        state.rejectedAt >= record.requestedAt &&
        state.rejectedAt === record.updatedAt
      );
    case 'failed':
      return (
        validVerifiedTimeline(record, state) &&
        state.startedAt >= state.verifiedAt &&
        state.failedAt >= state.startedAt &&
        state.failedAt === record.updatedAt
      );
    default:
      return assertNever(state, 'Unsupported privacy request state');
  }
}

export function isValidPrivacyRequestTransition(
  scope: PrivacyRequestScope,
  transition: PrivacyRequestTransition,
): boolean {
  const { current, next } = transition;
  return (
    isValidPrivacyRequest(current) &&
    isValidPrivacyRequest(next) &&
    sameScope(scope, current) &&
    sameScope(scope, next) &&
    sameIdentity(current, next) &&
    next.revision === current.revision + 1 &&
    next.updatedAt >= current.updatedAt &&
    validStateTransition(current.state, next.state)
  );
}

export function samePrivacyRequestRecord(
  left: PrivacyRequestRecord,
  right: PrivacyRequestRecord,
): boolean {
  return (
    sameIdentity(left, right) &&
    left.revision === right.revision &&
    left.requestedAt === right.requestedAt &&
    left.updatedAt === right.updatedAt &&
    sameState(left.state, right.state)
  );
}

function advance(
  current: PrivacyRequestRecord,
  state: PrivacyRequestState,
  updatedAt: number,
): PrivacyRequestTransitionPlan {
  const revision = decodeRevision(current.revision + 1);
  if (revision === undefined) {
    return { kind: 'rejected', reason: 'revision-limit' };
  }
  const next: PrivacyRequestRecord = {
    ...current,
    revision,
    state,
    updatedAt,
  };
  const transition = { current, next };
  return isValidPrivacyRequestTransition(current, transition)
    ? { kind: 'accepted', transition }
    : { kind: 'rejected', reason: 'wrong-state' };
}

function validStateTransition(
  current: PrivacyRequestState,
  next: PrivacyRequestState,
): boolean {
  switch (current.kind) {
    case 'verification-pending':
      return next.kind === 'ready' || next.kind === 'rejected';
    case 'ready':
      return next.kind === 'processing' && sameVerification(current, next);
    case 'processing':
      return (
        (next.kind === 'completed' || next.kind === 'failed') &&
        sameVerification(current, next) &&
        current.startedAt === next.startedAt
      );
    case 'failed':
      return (
        current.retryable &&
        next.kind === 'ready' &&
        sameVerification(current, next)
      );
    case 'completed':
    case 'rejected':
      return false;
    default:
      return assertNever(current, 'Unsupported privacy request transition');
  }
}

function sameState(
  left: PrivacyRequestState,
  right: PrivacyRequestState,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'verification-pending':
      return true;
    case 'ready':
      return right.kind === 'ready' && sameVerification(left, right);
    case 'processing':
      return (
        right.kind === 'processing' &&
        sameVerification(left, right) &&
        left.startedAt === right.startedAt
      );
    case 'completed':
      return (
        right.kind === 'completed' &&
        sameVerification(left, right) &&
        left.startedAt === right.startedAt &&
        left.completedAt === right.completedAt &&
        left.outcome === right.outcome
      );
    case 'rejected':
      return (
        right.kind === 'rejected' &&
        left.rejectedAt === right.rejectedAt &&
        left.reason === right.reason
      );
    case 'failed':
      return (
        right.kind === 'failed' &&
        sameVerification(left, right) &&
        left.startedAt === right.startedAt &&
        left.failedAt === right.failedAt &&
        left.failureCode === right.failureCode &&
        left.retryable === right.retryable
      );
    default:
      return assertNever(left, 'Unsupported privacy request comparison');
  }
}

function sameVerification(
  left: {
    readonly verificationReceiptId: PrivacyRequestVerificationReceiptId;
    readonly verifiedAt: number;
  },
  right: {
    readonly verificationReceiptId: PrivacyRequestVerificationReceiptId;
    readonly verifiedAt: number;
  },
): boolean {
  return (
    left.verificationReceiptId === right.verificationReceiptId &&
    left.verifiedAt === right.verifiedAt
  );
}

function validVerifiedTimeline(
  record: PrivacyRequestRecord,
  state: { readonly verifiedAt: number },
): boolean {
  return (
    validTimestamp(state.verifiedAt) &&
    state.verifiedAt >= record.requestedAt &&
    state.verifiedAt <= record.updatedAt
  );
}

function sameIdentity(
  left: PrivacyRequestRecord,
  right: PrivacyRequestRecord,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.vaultId === right.vaultId &&
    left.requestId === right.requestId &&
    left.submissionId === right.submissionId &&
    left.requestKind === right.requestKind &&
    left.requestedAt === right.requestedAt
  );
}

function sameScope(
  scope: PrivacyRequestScope,
  record: PrivacyRequestRecord,
): boolean {
  return (
    scope.accountId === record.accountId && scope.vaultId === record.vaultId
  );
}

function outcomeMatchesKind(
  requestKind: PrivacyRequestKind,
  outcome: PrivacyRequestOutcome,
): boolean {
  return requestKind === 'deletion'
    ? outcome === 'account-deletion-started'
    : outcome === 'fulfilled';
}

function validEventTimestamp(
  record: PrivacyRequestRecord,
  timestamp: number,
): boolean {
  return validTimestamp(timestamp) && timestamp >= record.updatedAt;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function decodeRevision(value: number) {
  const decoded = privacyRequestRevisionDecoder.decode(value);
  return decoded.ok ? decoded.value : undefined;
}
