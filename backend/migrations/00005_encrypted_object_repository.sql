-- +goose Up
CREATE TABLE vault_encrypted_objects (
  vault_id text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  object_revision bigint NOT NULL,
  write_id text NOT NULL,
  object_key text NOT NULL,
  plaintext_bytes bigint NOT NULL,
  ciphertext_bytes bigint NOT NULL,
  crypto_version text NOT NULL,
  dek_version bigint NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (vault_id, object_type, object_id, object_revision),
  CONSTRAINT vault_encrypted_objects_vault_fk
    FOREIGN KEY (vault_id) REFERENCES personal_vaults(vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_encrypted_objects_shape_check CHECK (
    object_type IN ('card', 'conflict')
    AND object_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND object_revision BETWEEN 1 AND 2147483647
    AND write_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND object_key ~ '^obj_v1_[A-Za-z0-9_-]{43}$'
    AND plaintext_bytes BETWEEN 0 AND 134217728
    AND ciphertext_bytes BETWEEN 1 AND 134217728
    AND crypto_version = 'fukamu-envelope-aes-256-gcm/v1'
    AND dek_version BETWEEN 1 AND 2147483647
    AND created_at BETWEEN 0 AND 9007199254740991
  )
);
CREATE UNIQUE INDEX idx_vault_encrypted_objects_write
  ON vault_encrypted_objects(vault_id, write_id);
CREATE UNIQUE INDEX idx_vault_encrypted_objects_key
  ON vault_encrypted_objects(object_key);
CREATE INDEX idx_vault_encrypted_objects_current
  ON vault_encrypted_objects(vault_id, object_type, object_id, object_revision DESC);

CREATE TABLE vault_encrypted_write_intents (
  vault_id text NOT NULL,
  write_id text NOT NULL,
  object_type text NOT NULL,
  object_id text NOT NULL,
  expected_revision bigint,
  object_revision bigint NOT NULL,
  object_key text NOT NULL,
  plaintext_bytes bigint NOT NULL,
  crypto_version text NOT NULL,
  dek_version bigint NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (vault_id, write_id),
  CONSTRAINT vault_encrypted_write_intents_vault_fk
    FOREIGN KEY (vault_id) REFERENCES personal_vaults(vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_encrypted_write_intents_shape_check CHECK (
    object_type IN ('card', 'conflict')
    AND object_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND (expected_revision IS NULL OR expected_revision BETWEEN 1 AND 2147483647)
    AND object_revision BETWEEN 1 AND 2147483647
    AND write_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND object_key ~ '^obj_v1_[A-Za-z0-9_-]{43}$'
    AND plaintext_bytes BETWEEN 0 AND 134217728
    AND crypto_version = 'fukamu-envelope-aes-256-gcm/v1'
    AND dek_version BETWEEN 1 AND 2147483647
    AND created_at BETWEEN 0 AND 9007199254740991
  )
);
CREATE UNIQUE INDEX idx_vault_encrypted_write_intents_target
  ON vault_encrypted_write_intents(vault_id, object_type, object_id, object_revision);
CREATE UNIQUE INDEX idx_vault_encrypted_write_intents_key
  ON vault_encrypted_write_intents(object_key);

CREATE TABLE vault_object_delete_outbox (
  vault_id text NOT NULL,
  object_key text NOT NULL,
  attempt_count bigint NOT NULL,
  next_attempt_at bigint NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (object_key),
  CONSTRAINT vault_object_delete_outbox_shape_check CHECK (
    object_key ~ '^obj_v1_[A-Za-z0-9_-]{43}$'
    AND attempt_count BETWEEN 0 AND 2147483647
    AND next_attempt_at BETWEEN 0 AND 9007199254740991
    AND created_at BETWEEN 0 AND 9007199254740991
  )
);
CREATE INDEX idx_vault_object_delete_outbox_ready
  ON vault_object_delete_outbox(vault_id, next_attempt_at, object_key);

-- +goose Down
DROP TABLE vault_object_delete_outbox;
DROP TABLE vault_encrypted_write_intents;
DROP TABLE vault_encrypted_objects;
