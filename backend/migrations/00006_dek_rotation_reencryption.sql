-- +goose Up
CREATE TABLE vault_dek_rotation_operations (
  vault_id text PRIMARY KEY,
  account_id text NOT NULL,
  operation_id text NOT NULL UNIQUE,
  revision bigint NOT NULL,
  source_version bigint NOT NULL,
  target_version bigint NOT NULL,
  state text NOT NULL,
  kek_key_reference text,
  wrapped_dek text,
  key_created_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  completed_at bigint,
  CONSTRAINT vault_dek_rotation_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_dek_rotation_shape_check CHECK (
    operation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND revision BETWEEN 1 AND 3
    AND source_version BETWEEN 1 AND 2147483646
    AND target_version = source_version + 1
    AND created_at BETWEEN 0 AND 9007199254740991
    AND updated_at BETWEEN created_at AND 9007199254740991
    AND (
      (state = 'generating' AND revision = 1
        AND kek_key_reference IS NULL AND wrapped_dek IS NULL
        AND key_created_at IS NULL AND completed_at IS NULL)
      OR
      (state = 'promoting' AND revision = 2
        AND char_length(kek_key_reference) BETWEEN 1 AND 2048
        AND char_length(wrapped_dek) BETWEEN 1 AND 16384
        AND wrapped_dek ~ '^[A-Za-z0-9_-]+$'
        AND key_created_at BETWEEN created_at AND updated_at
        AND completed_at IS NULL)
      OR
      (state = 'completed' AND revision = 3
        AND char_length(kek_key_reference) BETWEEN 1 AND 2048
        AND char_length(wrapped_dek) BETWEEN 1 AND 16384
        AND wrapped_dek ~ '^[A-Za-z0-9_-]+$'
        AND key_created_at BETWEEN created_at AND updated_at
        AND completed_at = updated_at)
    )
  )
);

CREATE TABLE vault_reencryption_jobs (
  vault_id text PRIMARY KEY,
  target_version bigint NOT NULL,
  after_object_type text,
  after_object_id text,
  after_object_revision bigint,
  state text NOT NULL,
  revision bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT vault_reencryption_vault_fk
    FOREIGN KEY (vault_id) REFERENCES personal_vaults(vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_reencryption_shape_check CHECK (
    target_version BETWEEN 1 AND 2147483647
    AND state IN ('running', 'completed')
    AND revision BETWEEN 1 AND 2147483647
    AND created_at BETWEEN 0 AND 9007199254740991
    AND updated_at BETWEEN created_at AND 9007199254740991
    AND (
      (after_object_type IS NULL AND after_object_id IS NULL AND after_object_revision IS NULL)
      OR
      (state = 'running'
        AND after_object_type IN ('card', 'conflict')
        AND after_object_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND after_object_revision BETWEEN 1 AND 2147483647)
    )
    AND (state <> 'completed' OR after_object_type IS NULL)
  )
);

-- +goose Down
DROP TABLE vault_reencryption_jobs;
DROP TABLE vault_dek_rotation_operations;
