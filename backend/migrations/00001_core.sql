-- +goose Up
CREATE TABLE cards (
  id text PRIMARY KEY,
  display_id bigint NOT NULL CHECK (display_id > 0),
  title text NOT NULL,
  body_json text NOT NULL,
  revision bigint NOT NULL CHECK (revision > 0),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  updated_at bigint NOT NULL CHECK (updated_at >= created_at),
  last_mutation_id text NOT NULL
);
CREATE UNIQUE INDEX idx_cards_display_id ON cards(display_id);

CREATE TABLE card_mutations (
  id text PRIMARY KEY,
  card_id text NOT NULL,
  created_at bigint NOT NULL CHECK (created_at >= 0)
);
CREATE INDEX idx_card_mutations_card_id ON card_mutations(card_id);

CREATE TABLE conflicts (
  id text PRIMARY KEY,
  card_id text NOT NULL,
  server_revision bigint NOT NULL CHECK (server_revision > 0),
  local_title text NOT NULL,
  local_body_json text NOT NULL,
  server_title text NOT NULL,
  server_body_json text NOT NULL,
  created_at bigint NOT NULL CHECK (created_at >= 0)
);
CREATE INDEX idx_conflicts_card_id ON conflicts(card_id);

CREATE TABLE sync_state (
  singleton smallint PRIMARY KEY CHECK (singleton = 1),
  next_display_id bigint NOT NULL CHECK (next_display_id > 0)
);

CREATE TABLE accounts (
  account_id text PRIMARY KEY,
  created_at bigint NOT NULL CHECK (created_at >= 0)
);

CREATE TABLE personal_vaults (
  vault_id text PRIMARY KEY,
  account_id text NOT NULL,
  created_at bigint NOT NULL CHECK (created_at >= 0),
  CONSTRAINT personal_vaults_account_fk
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
  CONSTRAINT personal_vaults_owner_unique UNIQUE (account_id, vault_id)
);
CREATE UNIQUE INDEX idx_personal_vaults_account ON personal_vaults(account_id);

CREATE TABLE identities (
  identity_id text PRIMARY KEY,
  account_id text NOT NULL,
  provider text NOT NULL CHECK (provider IN ('google-oidc', 'email-otp')),
  issuer text NOT NULL,
  subject text NOT NULL,
  created_at bigint NOT NULL CHECK (created_at >= 0),
  CONSTRAINT identities_account_fk
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
  CONSTRAINT identities_issuer_subject_unique UNIQUE (issuer, subject)
);
CREATE INDEX idx_identities_account ON identities(account_id);

CREATE TABLE sessions (
  session_id text PRIMARY KEY,
  account_id text NOT NULL,
  vault_id text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  session_epoch bigint NOT NULL CHECK (session_epoch > 0),
  issued_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at bigint,
  revocation_reason text,
  CONSTRAINT sessions_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT sessions_timeline_check CHECK (issued_at >= 0 AND expires_at > issued_at),
  CONSTRAINT sessions_revocation_check CHECK (
    (revoked_at IS NULL AND revocation_reason IS NULL) OR
    (revoked_at >= issued_at AND revocation_reason IN ('logout', 'rotated', 'security'))
  )
);
CREATE INDEX idx_sessions_account ON sessions(account_id);
CREATE INDEX idx_sessions_vault ON sessions(vault_id);
CREATE INDEX idx_sessions_expires_at ON sessions(expires_at);
CREATE INDEX idx_sessions_active_account
  ON sessions(account_id, expires_at, session_id) WHERE revoked_at IS NULL;

CREATE TABLE schema_migrations (
  migration_id text PRIMARY KEY,
  checksum text NOT NULL,
  applied_at bigint NOT NULL CHECK (applied_at >= 0)
);

CREATE TABLE launch_config (
  singleton smallint PRIMARY KEY CHECK (singleton = 1),
  public_access_enabled boolean NOT NULL,
  updated_at bigint NOT NULL CHECK (updated_at >= 0)
);

CREATE TABLE launch_allowed_users (
  user_id text PRIMARY KEY,
  created_at bigint NOT NULL CHECK (created_at >= 0),
  CONSTRAINT launch_allowed_users_user_id_check CHECK (
    char_length(user_id) BETWEEN 1 AND 256 AND btrim(user_id) = user_id
  )
);

INSERT INTO launch_config(singleton, public_access_enabled, updated_at)
VALUES (1, false, 0);

CREATE TABLE IF NOT EXISTS notes_goose_checksums (
  version_id bigint PRIMARY KEY CHECK (version_id > 0),
  source_path text NOT NULL UNIQUE,
  checksum text NOT NULL CHECK (checksum ~ '^sha256:[0-9a-f]{64}$')
);

-- +goose Down
DROP TABLE notes_goose_checksums;
DROP TABLE launch_allowed_users;
DROP TABLE launch_config;
DROP TABLE schema_migrations;
DROP TABLE sessions;
DROP TABLE identities;
DROP TABLE personal_vaults;
DROP TABLE accounts;
DROP TABLE sync_state;
DROP TABLE conflicts;
DROP TABLE card_mutations;
DROP TABLE cards;
