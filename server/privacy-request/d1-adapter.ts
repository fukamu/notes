import { BoundaryDecodeError, decodeOrThrow } from '../../lib/codec/core';
import type { D1DatabaseBinding } from '../../db/d1-types';
import { assertNever } from '../../lib/shared/invariant';
import {
  isInitialPrivacyRequest,
  isValidPrivacyRequestTransition,
  samePrivacyRequestRecord,
} from './core';
import { mapPrivacyRequestRow, privacyRequestRowDecoder } from './records';
import type {
  PrivacyRequestCommitResult,
  PrivacyRequestCreateResult,
  PrivacyRequestId,
  PrivacyRequestRecord,
  PrivacyRequestRepository,
  PrivacyRequestScope,
  PrivacyRequestState,
  PrivacyRequestSubmissionId,
  PrivacyRequestTransition,
} from './public';

const requestColumns = `account_id, vault_id, request_id, submission_id,
  request_kind, revision, state, verification_receipt_id, verified_at,
  started_at, completed_at, outcome, rejected_at, rejection_reason,
  failed_at, failure_code, retryable, requested_at, updated_at`;

export class D1PrivacyRequestRepository implements PrivacyRequestRepository {
  constructor(private readonly database: D1DatabaseBinding) {}

  findById(
    scope: PrivacyRequestScope,
    requestId: PrivacyRequestId,
  ): Promise<PrivacyRequestRecord | undefined> {
    return this.readOne(
      `SELECT ${requestColumns} FROM privacy_requests
       WHERE account_id = ? AND vault_id = ? AND request_id = ?`,
      [scope.accountId, scope.vaultId, requestId],
    );
  }

  findBySubmission(
    scope: PrivacyRequestScope,
    submissionId: PrivacyRequestSubmissionId,
  ): Promise<PrivacyRequestRecord | undefined> {
    return this.readOne(
      `SELECT ${requestColumns} FROM privacy_requests
       WHERE account_id = ? AND vault_id = ? AND submission_id = ?`,
      [scope.accountId, scope.vaultId, submissionId],
    );
  }

  async create(
    record: PrivacyRequestRecord,
  ): Promise<PrivacyRequestCreateResult> {
    if (!isInitialPrivacyRequest(record)) {
      return { kind: 'rejected', reason: 'invalid-record' };
    }
    try {
      const result = await this.database
        .prepare(
          `INSERT INTO privacy_requests(${requestColumns})
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(...recordBindings(record))
        .run();
      if (result.meta.changes !== 1) {
        throw new Error('privacy request insert did not change one row');
      }
      return { kind: 'created', record };
    } catch (error: unknown) {
      const scope = requestScope(record);
      const [submission, request] = await Promise.all([
        this.findBySubmission(scope, record.submissionId),
        this.findById(scope, record.requestId),
      ]);
      if (submission !== undefined) {
        return submission.requestKind === record.requestKind
          ? { kind: 'existing', record: submission }
          : { kind: 'conflict' };
      }
      if (request !== undefined) {
        return request.submissionId === record.submissionId &&
          request.requestKind === record.requestKind
          ? { kind: 'existing', record: request }
          : { kind: 'conflict' };
      }
      throw error;
    }
  }

  async commit(
    scope: PrivacyRequestScope,
    transition: PrivacyRequestTransition,
  ): Promise<PrivacyRequestCommitResult> {
    if (!isValidPrivacyRequestTransition(scope, transition)) {
      return { kind: 'rejected', reason: 'invalid-transition' };
    }
    const result = await this.database
      .prepare(
        `UPDATE privacy_requests SET
          revision = ?, state = ?, verification_receipt_id = ?,
          verified_at = ?, started_at = ?, completed_at = ?, outcome = ?,
          rejected_at = ?, rejection_reason = ?, failed_at = ?,
          failure_code = ?, retryable = ?, updated_at = ?
         WHERE account_id = ? AND vault_id = ? AND request_id = ?
           AND revision = ?`,
      )
      .bind(
        ...mutableBindings(transition.next),
        scope.accountId,
        scope.vaultId,
        transition.current.requestId,
        transition.current.revision,
      )
      .run();
    const persisted = await this.findById(scope, transition.current.requestId);
    if (result.meta.changes === 1) {
      if (
        persisted === undefined ||
        !samePrivacyRequestRecord(persisted, transition.next)
      ) {
        throw new BoundaryDecodeError('D1 privacy request commit', [
          { path: [], reason: 'applied transition could not be reloaded' },
        ]);
      }
      return { kind: 'applied', record: persisted };
    }
    if (
      persisted !== undefined &&
      samePrivacyRequestRecord(persisted, transition.next)
    ) {
      return { kind: 'replayed', record: persisted };
    }
    return { kind: 'conflict', current: persisted };
  }

  private async readOne(
    sql: string,
    bindings: readonly [string, string, string],
  ): Promise<PrivacyRequestRecord | undefined> {
    const candidate: unknown = await this.database
      .prepare(sql)
      .bind(...bindings)
      .first();
    return candidate === null
      ? undefined
      : mapPrivacyRequestRow(
          decodeOrThrow(
            privacyRequestRowDecoder,
            candidate,
            'D1 privacy request row',
          ),
        );
  }
}

function requestScope(record: PrivacyRequestRecord): PrivacyRequestScope {
  return { accountId: record.accountId, vaultId: record.vaultId };
}

function recordBindings(record: PrivacyRequestRecord): readonly unknown[] {
  return [
    record.accountId,
    record.vaultId,
    record.requestId,
    record.submissionId,
    record.requestKind,
    record.revision,
    ...stateBindings(record.state),
    record.requestedAt,
    record.updatedAt,
  ];
}

function mutableBindings(record: PrivacyRequestRecord): readonly unknown[] {
  return [record.revision, ...stateBindings(record.state), record.updatedAt];
}

function stateBindings(state: PrivacyRequestState): readonly unknown[] {
  switch (state.kind) {
    case 'verification-pending':
      return [
        'verification-pending',
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
    case 'ready':
      return [
        'ready',
        state.verificationReceiptId,
        state.verifiedAt,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
    case 'processing':
      return [
        'processing',
        state.verificationReceiptId,
        state.verifiedAt,
        state.startedAt,
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ];
    case 'completed':
      return [
        'completed',
        state.verificationReceiptId,
        state.verifiedAt,
        state.startedAt,
        state.completedAt,
        state.outcome,
        null,
        null,
        null,
        null,
        null,
      ];
    case 'rejected':
      return [
        'rejected',
        null,
        null,
        null,
        null,
        null,
        state.rejectedAt,
        state.reason,
        null,
        null,
        null,
      ];
    case 'failed':
      return [
        'failed',
        state.verificationReceiptId,
        state.verifiedAt,
        state.startedAt,
        null,
        null,
        null,
        null,
        state.failedAt,
        state.failureCode,
        state.retryable ? 1 : 0,
      ];
    default:
      return assertNever(state, 'Unsupported privacy request state binding');
  }
}
