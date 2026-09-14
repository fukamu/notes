import {
  BoundaryDecodeError,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  safeIntegerDecoder,
  transformDecoder,
  unionDecoder,
  type InferDecoder,
} from '../../lib/codec/core';
import { accountIdDecoder, vaultIdDecoder } from '../../lib/domain/identity';
import { isValidPrivacyRequest } from './core';
import {
  privacyRequestFailureCodeDecoder,
  privacyRequestIdDecoder,
  privacyRequestKindDecoder,
  privacyRequestOutcomeDecoder,
  privacyRequestRejectionReasonDecoder,
  privacyRequestRevisionDecoder,
  privacyRequestSubmissionIdDecoder,
  privacyRequestVerificationReceiptIdDecoder,
  type PrivacyRequestRecord,
  type PrivacyRequestState,
} from './public';

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const stateDecoder = unionDecoder(
  literalDecoder('verification-pending'),
  literalDecoder('ready'),
  literalDecoder('processing'),
  literalDecoder('completed'),
  literalDecoder('rejected'),
  literalDecoder('failed'),
);
const sqliteBooleanDecoder = transformDecoder(
  safeIntegerDecoder({ minimum: 0, maximum: 1 }),
  (value) => value === 1,
);

export const privacyRequestRowDecoder = objectDecoder({
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  request_id: privacyRequestIdDecoder,
  submission_id: privacyRequestSubmissionIdDecoder,
  request_kind: privacyRequestKindDecoder,
  revision: privacyRequestRevisionDecoder,
  state: stateDecoder,
  verification_receipt_id: nullableDecoder(
    privacyRequestVerificationReceiptIdDecoder,
  ),
  verified_at: nullableDecoder(timestampDecoder),
  started_at: nullableDecoder(timestampDecoder),
  completed_at: nullableDecoder(timestampDecoder),
  outcome: nullableDecoder(privacyRequestOutcomeDecoder),
  rejected_at: nullableDecoder(timestampDecoder),
  rejection_reason: nullableDecoder(privacyRequestRejectionReasonDecoder),
  failed_at: nullableDecoder(timestampDecoder),
  failure_code: nullableDecoder(privacyRequestFailureCodeDecoder),
  retryable: nullableDecoder(sqliteBooleanDecoder),
  requested_at: timestampDecoder,
  updated_at: timestampDecoder,
});

export type PrivacyRequestRow = InferDecoder<typeof privacyRequestRowDecoder>;

export function mapPrivacyRequestRow(
  row: PrivacyRequestRow,
): PrivacyRequestRecord {
  const state = mapState(row);
  const record: PrivacyRequestRecord = {
    accountId: row.account_id,
    vaultId: row.vault_id,
    requestId: row.request_id,
    submissionId: row.submission_id,
    requestKind: row.request_kind,
    revision: row.revision,
    state,
    requestedAt: row.requested_at,
    updatedAt: row.updated_at,
  };
  if (!isValidPrivacyRequest(record)) {
    return invalidRow('request timeline is inconsistent');
  }
  return record;
}

function mapState(row: PrivacyRequestRow): PrivacyRequestState {
  switch (row.state) {
    case 'verification-pending':
      if (!onlyNullStateFields(row)) {
        return invalidRow('invalid verification-pending state');
      }
      return { kind: 'verification-pending' };
    case 'ready':
      if (
        row.verification_receipt_id === null ||
        row.verified_at === null ||
        row.started_at !== null ||
        row.completed_at !== null ||
        row.outcome !== null ||
        row.rejected_at !== null ||
        row.rejection_reason !== null ||
        row.failed_at !== null ||
        row.failure_code !== null ||
        row.retryable !== null
      ) {
        return invalidRow('invalid ready state');
      }
      return {
        kind: 'ready',
        verificationReceiptId: row.verification_receipt_id,
        verifiedAt: row.verified_at,
      };
    case 'processing':
      if (
        row.verification_receipt_id === null ||
        row.verified_at === null ||
        row.started_at === null ||
        row.completed_at !== null ||
        row.outcome !== null ||
        row.rejected_at !== null ||
        row.rejection_reason !== null ||
        row.failed_at !== null ||
        row.failure_code !== null ||
        row.retryable !== null
      ) {
        return invalidRow('invalid processing state');
      }
      return {
        kind: 'processing',
        verificationReceiptId: row.verification_receipt_id,
        verifiedAt: row.verified_at,
        startedAt: row.started_at,
      };
    case 'completed':
      if (
        row.verification_receipt_id === null ||
        row.verified_at === null ||
        row.started_at === null ||
        row.completed_at === null ||
        row.outcome === null ||
        row.rejected_at !== null ||
        row.rejection_reason !== null ||
        row.failed_at !== null ||
        row.failure_code !== null ||
        row.retryable !== null
      ) {
        return invalidRow('invalid completed state');
      }
      return {
        kind: 'completed',
        verificationReceiptId: row.verification_receipt_id,
        verifiedAt: row.verified_at,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        outcome: row.outcome,
      };
    case 'rejected':
      if (
        row.verification_receipt_id !== null ||
        row.verified_at !== null ||
        row.started_at !== null ||
        row.completed_at !== null ||
        row.outcome !== null ||
        row.rejected_at === null ||
        row.rejection_reason === null ||
        row.failed_at !== null ||
        row.failure_code !== null ||
        row.retryable !== null
      ) {
        return invalidRow('invalid rejected state');
      }
      return {
        kind: 'rejected',
        rejectedAt: row.rejected_at,
        reason: row.rejection_reason,
      };
    case 'failed':
      if (
        row.verification_receipt_id === null ||
        row.verified_at === null ||
        row.started_at === null ||
        row.completed_at !== null ||
        row.outcome !== null ||
        row.rejected_at !== null ||
        row.rejection_reason !== null ||
        row.failed_at === null ||
        row.failure_code === null ||
        row.retryable === null
      ) {
        return invalidRow('invalid failed state');
      }
      return {
        kind: 'failed',
        verificationReceiptId: row.verification_receipt_id,
        verifiedAt: row.verified_at,
        startedAt: row.started_at,
        failedAt: row.failed_at,
        failureCode: row.failure_code,
        retryable: row.retryable,
      };
  }
}

function onlyNullStateFields(row: PrivacyRequestRow): boolean {
  return (
    row.verification_receipt_id === null &&
    row.verified_at === null &&
    row.started_at === null &&
    row.completed_at === null &&
    row.outcome === null &&
    row.rejected_at === null &&
    row.rejection_reason === null &&
    row.failed_at === null &&
    row.failure_code === null &&
    row.retryable === null
  );
}

function invalidRow(reason: string): never {
  throw new BoundaryDecodeError('D1 privacy request row', [
    { path: ['state'], reason },
  ]);
}
