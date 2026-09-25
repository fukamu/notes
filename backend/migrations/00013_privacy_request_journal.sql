-- +goose Up
CREATE TABLE privacy_requests (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  request_id text NOT NULL,
  submission_id text NOT NULL,
  request_kind text NOT NULL,
  revision integer NOT NULL,
  state text NOT NULL,
  verification_receipt_id text,
  verified_at bigint,
  started_at bigint,
  completed_at bigint,
  outcome text,
  rejected_at bigint,
  rejection_reason text,
  failed_at bigint,
  failure_code text,
  retryable boolean,
  requested_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (account_id, vault_id, request_id),
  CONSTRAINT privacy_requests_submission_unique
    UNIQUE (account_id, vault_id, submission_id),
  CONSTRAINT privacy_requests_shape_check CHECK (
    account_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND vault_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND request_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND submission_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND request_kind IN (
      'purpose-notification', 'disclosure', 'correction',
      'usage-suspension', 'deletion',
      'third-party-provision-suspension'
    )
    AND revision BETWEEN 1 AND 2147483647
    AND requested_at BETWEEN 0 AND 9007199254740991
    AND updated_at BETWEEN requested_at AND 9007199254740991
    AND (verification_receipt_id IS NULL OR
      verification_receipt_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    AND (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9-]{0,63}$')
    AND (outcome IS NULL OR (
      (request_kind = 'deletion' AND outcome = 'account-deletion-started') OR
      (request_kind <> 'deletion' AND outcome = 'fulfilled')
    ))
    AND (
      (state = 'verification-pending'
        AND revision = 1 AND updated_at = requested_at
        AND verification_receipt_id IS NULL AND verified_at IS NULL
        AND started_at IS NULL AND completed_at IS NULL AND outcome IS NULL
        AND rejected_at IS NULL AND rejection_reason IS NULL
        AND failed_at IS NULL AND failure_code IS NULL AND retryable IS NULL)
      OR
      (state = 'ready'
        AND verification_receipt_id IS NOT NULL
        AND verified_at BETWEEN requested_at AND updated_at
        AND started_at IS NULL AND completed_at IS NULL AND outcome IS NULL
        AND rejected_at IS NULL AND rejection_reason IS NULL
        AND failed_at IS NULL AND failure_code IS NULL AND retryable IS NULL)
      OR
      (state = 'processing'
        AND verification_receipt_id IS NOT NULL
        AND verified_at BETWEEN requested_at AND updated_at
        AND started_at = updated_at AND started_at >= verified_at
        AND completed_at IS NULL AND outcome IS NULL
        AND rejected_at IS NULL AND rejection_reason IS NULL
        AND failed_at IS NULL AND failure_code IS NULL AND retryable IS NULL)
      OR
      (state = 'completed'
        AND verification_receipt_id IS NOT NULL
        AND verified_at BETWEEN requested_at AND updated_at
        AND started_at >= verified_at AND completed_at = updated_at
        AND completed_at >= started_at AND outcome IS NOT NULL
        AND rejected_at IS NULL AND rejection_reason IS NULL
        AND failed_at IS NULL AND failure_code IS NULL AND retryable IS NULL)
      OR
      (state = 'rejected'
        AND verification_receipt_id IS NULL AND verified_at IS NULL
        AND started_at IS NULL AND completed_at IS NULL AND outcome IS NULL
        AND rejected_at = updated_at AND rejected_at >= requested_at
        AND rejection_reason IN ('identity-not-verified', 'request-not-applicable')
        AND failed_at IS NULL AND failure_code IS NULL AND retryable IS NULL)
      OR
      (state = 'failed'
        AND verification_receipt_id IS NOT NULL
        AND verified_at BETWEEN requested_at AND updated_at
        AND started_at >= verified_at AND failed_at = updated_at
        AND failed_at >= started_at
        AND completed_at IS NULL AND outcome IS NULL
        AND rejected_at IS NULL AND rejection_reason IS NULL
        AND failure_code IS NOT NULL AND retryable IS NOT NULL)
    )
  )
);

CREATE INDEX idx_privacy_requests_state
  ON privacy_requests(account_id, vault_id, state, updated_at, request_id);

-- The journal deliberately has no owner foreign key: an accepted deletion
-- request must remain trackable after its live Account/Vault rows are removed.
-- New rows still require an exact current Personal Vault owner.
-- +goose StatementBegin
CREATE FUNCTION enforce_privacy_request_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM personal_vaults
    WHERE account_id = NEW.account_id AND vault_id = NEW.vault_id
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'privacy request owner is missing'
    USING ERRCODE = '23503', CONSTRAINT = 'privacy_request_owner';
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER privacy_request_owner
  BEFORE INSERT ON privacy_requests
  FOR EACH ROW EXECUTE FUNCTION enforce_privacy_request_owner();

-- +goose Down
DROP TABLE privacy_requests;
DROP FUNCTION enforce_privacy_request_owner();
