import type { MigrationDefinition } from '../migrations/core';

export const privacyRequestJournalStatements = [
  `CREATE TABLE privacy_requests (
    account_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    request_kind TEXT NOT NULL,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL,
    verification_receipt_id TEXT,
    verified_at INTEGER,
    started_at INTEGER,
    completed_at INTEGER,
    outcome TEXT,
    rejected_at INTEGER,
    rejection_reason TEXT,
    failed_at INTEGER,
    failure_code TEXT,
    retryable INTEGER,
    requested_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, vault_id, request_id),
    CONSTRAINT privacy_requests_shape_check CHECK (
      length(request_id) = 36
      AND length(submission_id) = 36
      AND request_kind IN (
        'purpose-notification', 'disclosure', 'correction',
        'usage-suspension', 'deletion',
        'third-party-provision-suspension'
      )
      AND revision BETWEEN 1 AND 2147483647
      AND requested_at >= 0 AND updated_at >= requested_at
      AND (verification_receipt_id IS NULL
        OR length(verification_receipt_id) = 36)
      AND (failure_code IS NULL OR length(failure_code) BETWEEN 1 AND 64)
      AND (retryable IS NULL OR retryable IN (0, 1))
      AND (outcome IS NULL OR (
        (request_kind = 'deletion' AND outcome = 'account-deletion-started')
        OR (request_kind <> 'deletion' AND outcome = 'fulfilled')
      ))
      AND (
        (state = 'verification-pending'
          AND revision = 1 AND updated_at = requested_at
          AND verification_receipt_id IS NULL AND verified_at IS NULL
          AND started_at IS NULL AND completed_at IS NULL
          AND outcome IS NULL AND rejected_at IS NULL
          AND rejection_reason IS NULL AND failed_at IS NULL
          AND failure_code IS NULL AND retryable IS NULL)
        OR (state = 'ready'
          AND verification_receipt_id IS NOT NULL
          AND verified_at BETWEEN requested_at AND updated_at
          AND started_at IS NULL AND completed_at IS NULL
          AND outcome IS NULL AND rejected_at IS NULL
          AND rejection_reason IS NULL AND failed_at IS NULL
          AND failure_code IS NULL AND retryable IS NULL)
        OR (state = 'processing'
          AND verification_receipt_id IS NOT NULL
          AND verified_at BETWEEN requested_at AND started_at
          AND started_at = updated_at AND completed_at IS NULL
          AND outcome IS NULL AND rejected_at IS NULL
          AND rejection_reason IS NULL AND failed_at IS NULL
          AND failure_code IS NULL AND retryable IS NULL)
        OR (state = 'completed'
          AND verification_receipt_id IS NOT NULL
          AND verified_at BETWEEN requested_at AND started_at
          AND started_at <= completed_at AND completed_at = updated_at
          AND outcome IS NOT NULL AND rejected_at IS NULL
          AND rejection_reason IS NULL AND failed_at IS NULL
          AND failure_code IS NULL AND retryable IS NULL)
        OR (state = 'rejected'
          AND verification_receipt_id IS NULL AND verified_at IS NULL
          AND started_at IS NULL AND completed_at IS NULL
          AND outcome IS NULL AND rejected_at = updated_at
          AND rejected_at >= requested_at
          AND rejection_reason IN (
            'identity-not-verified', 'request-not-applicable'
          )
          AND failed_at IS NULL AND failure_code IS NULL
          AND retryable IS NULL)
        OR (state = 'failed'
          AND verification_receipt_id IS NOT NULL
          AND verified_at BETWEEN requested_at AND started_at
          AND started_at <= failed_at AND failed_at = updated_at
          AND completed_at IS NULL AND outcome IS NULL
          AND rejected_at IS NULL AND rejection_reason IS NULL
          AND failure_code IS NOT NULL AND retryable IN (0, 1))
      )
    )
  )`,
  `CREATE UNIQUE INDEX idx_privacy_requests_submission
    ON privacy_requests(account_id, vault_id, submission_id)`,
  `CREATE INDEX idx_privacy_requests_state
    ON privacy_requests(account_id, vault_id, state, updated_at, request_id)`,
] as const;

export const privacyRequestJournalMigration: MigrationDefinition = {
  id: '0014_privacy_request_journal',
  checksum:
    'sha256:cfdbf3c5afd77775c5f28d7efee049688371948903dfd63ebe6273ccf0c17897',
  statements: privacyRequestJournalStatements,
};
