import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const privacyRequests = sqliteTable(
  'privacy_requests',
  {
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    requestId: text('request_id').notNull(),
    submissionId: text('submission_id').notNull(),
    requestKind: text('request_kind').notNull(),
    revision: integer('revision').notNull(),
    state: text('state').notNull(),
    verificationReceiptId: text('verification_receipt_id'),
    verifiedAt: integer('verified_at'),
    startedAt: integer('started_at'),
    completedAt: integer('completed_at'),
    outcome: text('outcome'),
    rejectedAt: integer('rejected_at'),
    rejectionReason: text('rejection_reason'),
    failedAt: integer('failed_at'),
    failureCode: text('failure_code'),
    retryable: integer('retryable'),
    requestedAt: integer('requested_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.vaultId, table.requestId],
    }),
    uniqueIndex('idx_privacy_requests_submission').on(
      table.accountId,
      table.vaultId,
      table.submissionId,
    ),
    index('idx_privacy_requests_state').on(
      table.accountId,
      table.vaultId,
      table.state,
      table.updatedAt,
      table.requestId,
    ),
    check(
      'privacy_requests_shape_check',
      sql`length(${table.requestId}) = 36
        AND length(${table.submissionId}) = 36
        AND ${table.requestKind} IN (
          'purpose-notification', 'disclosure', 'correction',
          'usage-suspension', 'deletion',
          'third-party-provision-suspension'
        )
        AND ${table.revision} BETWEEN 1 AND 2147483647
        AND ${table.requestedAt} >= 0
        AND ${table.updatedAt} >= ${table.requestedAt}
        AND (${table.verificationReceiptId} IS NULL
          OR length(${table.verificationReceiptId}) = 36)
        AND (${table.failureCode} IS NULL
          OR length(${table.failureCode}) BETWEEN 1 AND 64)
        AND (${table.retryable} IS NULL OR ${table.retryable} IN (0, 1))
        AND (${table.outcome} IS NULL OR (
          (${table.requestKind} = 'deletion'
            AND ${table.outcome} = 'account-deletion-started')
          OR (${table.requestKind} <> 'deletion'
            AND ${table.outcome} = 'fulfilled')
        ))
        AND (
          (${table.state} = 'verification-pending'
            AND ${table.revision} = 1
            AND ${table.updatedAt} = ${table.requestedAt}
            AND ${table.verificationReceiptId} IS NULL
            AND ${table.verifiedAt} IS NULL
            AND ${table.startedAt} IS NULL
            AND ${table.completedAt} IS NULL
            AND ${table.outcome} IS NULL
            AND ${table.rejectedAt} IS NULL
            AND ${table.rejectionReason} IS NULL
            AND ${table.failedAt} IS NULL
            AND ${table.failureCode} IS NULL
            AND ${table.retryable} IS NULL)
          OR (${table.state} = 'ready'
            AND ${table.verificationReceiptId} IS NOT NULL
            AND ${table.verifiedAt} BETWEEN ${table.requestedAt} AND ${table.updatedAt}
            AND ${table.startedAt} IS NULL
            AND ${table.completedAt} IS NULL
            AND ${table.outcome} IS NULL
            AND ${table.rejectedAt} IS NULL
            AND ${table.rejectionReason} IS NULL
            AND ${table.failedAt} IS NULL
            AND ${table.failureCode} IS NULL
            AND ${table.retryable} IS NULL)
          OR (${table.state} = 'processing'
            AND ${table.verificationReceiptId} IS NOT NULL
            AND ${table.verifiedAt} BETWEEN ${table.requestedAt} AND ${table.startedAt}
            AND ${table.startedAt} = ${table.updatedAt}
            AND ${table.completedAt} IS NULL
            AND ${table.outcome} IS NULL
            AND ${table.rejectedAt} IS NULL
            AND ${table.rejectionReason} IS NULL
            AND ${table.failedAt} IS NULL
            AND ${table.failureCode} IS NULL
            AND ${table.retryable} IS NULL)
          OR (${table.state} = 'completed'
            AND ${table.verificationReceiptId} IS NOT NULL
            AND ${table.verifiedAt} BETWEEN ${table.requestedAt} AND ${table.startedAt}
            AND ${table.startedAt} <= ${table.completedAt}
            AND ${table.completedAt} = ${table.updatedAt}
            AND ${table.outcome} IS NOT NULL
            AND ${table.rejectedAt} IS NULL
            AND ${table.rejectionReason} IS NULL
            AND ${table.failedAt} IS NULL
            AND ${table.failureCode} IS NULL
            AND ${table.retryable} IS NULL)
          OR (${table.state} = 'rejected'
            AND ${table.verificationReceiptId} IS NULL
            AND ${table.verifiedAt} IS NULL
            AND ${table.startedAt} IS NULL
            AND ${table.completedAt} IS NULL
            AND ${table.outcome} IS NULL
            AND ${table.rejectedAt} = ${table.updatedAt}
            AND ${table.rejectedAt} >= ${table.requestedAt}
            AND ${table.rejectionReason} IN (
              'identity-not-verified', 'request-not-applicable'
            )
            AND ${table.failedAt} IS NULL
            AND ${table.failureCode} IS NULL
            AND ${table.retryable} IS NULL)
          OR (${table.state} = 'failed'
            AND ${table.verificationReceiptId} IS NOT NULL
            AND ${table.verifiedAt} BETWEEN ${table.requestedAt} AND ${table.startedAt}
            AND ${table.startedAt} <= ${table.failedAt}
            AND ${table.failedAt} = ${table.updatedAt}
            AND ${table.completedAt} IS NULL
            AND ${table.outcome} IS NULL
            AND ${table.rejectedAt} IS NULL
            AND ${table.rejectionReason} IS NULL
            AND ${table.failureCode} IS NOT NULL
            AND ${table.retryable} IN (0, 1))
        )`,
    ),
  ],
);
