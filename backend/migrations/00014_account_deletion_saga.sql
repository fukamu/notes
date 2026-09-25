-- +goose Up
CREATE TABLE account_deletion_operations (
  operation_id text PRIMARY KEY,
  account_id text NOT NULL,
  vault_id text NOT NULL,
  revision integer NOT NULL,
  state text NOT NULL,
  current_step text,
  attempt integer NOT NULL,
  not_before bigint,
  lease_expires_at bigint,
  failure_code text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  completed_at bigint,
  CONSTRAINT account_deletion_operations_account_unique UNIQUE (account_id),
  CONSTRAINT account_deletion_operations_shape_check CHECK (
    operation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND account_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND vault_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND revision BETWEEN 1 AND 2147483647
    AND attempt BETWEEN 0 AND 1000
    AND created_at BETWEEN 0 AND 9007199254740991
    AND updated_at BETWEEN created_at AND 9007199254740991
    AND (current_step IS NULL OR current_step IN (
      'revoke-sessions', 'cancel-subscription', 'delete-vault-data',
      'delete-private-objects', 'finalize-account'
    ))
    AND (failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9-]{0,63}$')
    AND (
      (state = 'ready'
        AND current_step IS NOT NULL
        AND not_before BETWEEN updated_at AND 9007199254740991
        AND lease_expires_at IS NULL AND failure_code IS NULL
        AND completed_at IS NULL)
      OR
      (state = 'running'
        AND current_step IS NOT NULL AND attempt > 0
        AND not_before IS NULL
        AND lease_expires_at BETWEEN updated_at + 1 AND 9007199254740991
        AND failure_code IS NULL AND completed_at IS NULL)
      OR
      (state = 'retry-wait'
        AND current_step IS NOT NULL AND attempt > 0
        AND not_before BETWEEN updated_at AND 9007199254740991
        AND lease_expires_at IS NULL AND failure_code IS NOT NULL
        AND completed_at IS NULL)
      OR
      (state = 'terminal-failure'
        AND current_step IS NOT NULL AND attempt > 0
        AND not_before IS NULL AND lease_expires_at IS NULL
        AND failure_code IS NOT NULL AND completed_at IS NULL)
      OR
      (state = 'completed'
        AND current_step IS NULL AND attempt = 0
        AND not_before IS NULL AND lease_expires_at IS NULL
        AND failure_code IS NULL AND completed_at = updated_at)
    )
  )
);

CREATE INDEX idx_account_deletion_operations_ready
  ON account_deletion_operations(state, not_before, operation_id);

CREATE TABLE account_deletion_step_receipts (
  operation_id text NOT NULL,
  step text NOT NULL,
  completed_at bigint NOT NULL,
  PRIMARY KEY (operation_id, step),
  CONSTRAINT account_deletion_receipts_operation_fk
    FOREIGN KEY (operation_id) REFERENCES account_deletion_operations(operation_id) ON DELETE CASCADE,
  CONSTRAINT account_deletion_receipts_shape_check CHECK (
    step IN (
      'revoke-sessions', 'cancel-subscription', 'delete-vault-data',
      'delete-private-objects', 'finalize-account'
    )
    AND completed_at BETWEEN 0 AND 9007199254740991
  )
);

CREATE TABLE account_deletion_continuations (
  operation_id text PRIMARY KEY,
  idempotency_key_hash text NOT NULL,
  secret_hash text NOT NULL,
  sequence integer NOT NULL,
  expires_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT account_deletion_continuations_operation_fk
    FOREIGN KEY (operation_id) REFERENCES account_deletion_operations(operation_id) ON DELETE CASCADE,
  CONSTRAINT account_deletion_continuations_shape_check CHECK (
    idempotency_key_hash ~ '^[A-Za-z0-9_-]{43}$'
    AND secret_hash ~ '^[A-Za-z0-9_-]{43}$'
    AND sequence BETWEEN 0 AND 2147483647
    AND created_at BETWEEN 0 AND 9007199254740991
    AND expires_at BETWEEN created_at + 1 AND 9007199254740991
    AND updated_at BETWEEN created_at AND expires_at - 1
  )
);

CREATE UNIQUE INDEX idx_account_deletion_continuations_secret
  ON account_deletion_continuations(secret_hash);

CREATE INDEX idx_account_deletion_continuations_expiry
  ON account_deletion_continuations(expires_at, operation_id);

-- The operation/capability survives live Account/Vault finalization. New
-- operations still require an exact current Personal Vault owner.
-- +goose StatementBegin
CREATE FUNCTION enforce_account_deletion_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM personal_vaults
    WHERE account_id = NEW.account_id AND vault_id = NEW.vault_id
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'account deletion owner is missing'
    USING ERRCODE = '23503', CONSTRAINT = 'account_deletion_owner';
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER account_deletion_owner
  BEFORE INSERT ON account_deletion_operations
  FOR EACH ROW EXECUTE FUNCTION enforce_account_deletion_owner();

-- +goose Down
DROP TABLE account_deletion_continuations;
DROP TABLE account_deletion_step_receipts;
DROP TABLE account_deletion_operations;
DROP FUNCTION enforce_account_deletion_owner();
