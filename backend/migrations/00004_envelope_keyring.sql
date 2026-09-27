-- +goose Up
CREATE TABLE vault_dek_versions (
  vault_id text NOT NULL,
  dek_version bigint NOT NULL,
  kek_key_reference text NOT NULL,
  wrapped_dek text NOT NULL,
  is_write_key boolean NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (vault_id, dek_version),
  CONSTRAINT vault_dek_versions_vault_fk
    FOREIGN KEY (vault_id) REFERENCES personal_vaults(vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_dek_versions_version_check CHECK (
    dek_version BETWEEN 1 AND 2147483647
  ),
  CONSTRAINT vault_dek_versions_kek_reference_check CHECK (
    char_length(kek_key_reference) BETWEEN 1 AND 2048
  ),
  CONSTRAINT vault_dek_versions_wrapped_check CHECK (
    char_length(wrapped_dek) BETWEEN 1 AND 16384
    AND wrapped_dek ~ '^[A-Za-z0-9_-]+$'
  ),
  CONSTRAINT vault_dek_versions_created_at_check CHECK (
    created_at BETWEEN 0 AND 9007199254740991
  )
);
CREATE UNIQUE INDEX idx_vault_dek_versions_write
  ON vault_dek_versions(vault_id) WHERE is_write_key;
CREATE INDEX idx_vault_dek_versions_created
  ON vault_dek_versions(vault_id, created_at, dek_version);

-- +goose Down
DROP TABLE vault_dek_versions;
