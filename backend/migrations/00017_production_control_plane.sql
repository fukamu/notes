-- +goose Up
CREATE TABLE oidc_login_transactions (
  state text PRIMARY KEY CHECK (state ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  nonce text NOT NULL UNIQUE CHECK (nonce ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'),
  code_verifier text NOT NULL CHECK (
    char_length(code_verifier) BETWEEN 43 AND 128 AND
    code_verifier ~ '^[A-Za-z0-9._~-]+$'
  ),
  redirect_uri text NOT NULL CHECK (char_length(redirect_uri) BETWEEN 1 AND 2048),
  purpose text NOT NULL CHECK (purpose IN ('sign-in', 'link')),
  purpose_account_id text,
  signup_submission_id text,
  signup_terms_version text,
  signup_terms_hash text,
  signup_affirmed boolean,
  created_at_seconds bigint NOT NULL CHECK (
    created_at_seconds BETWEEN 0 AND 9007199254740991
  ),
  expires_at_seconds bigint NOT NULL CHECK (
    expires_at_seconds > created_at_seconds AND
    expires_at_seconds <= created_at_seconds + 600 AND
    expires_at_seconds <= 9007199254740991
  ),
  CONSTRAINT oidc_login_transactions_state_nonce_distinct CHECK (state <> nonce),
  CONSTRAINT oidc_login_transactions_purpose_shape CHECK (
    (purpose = 'sign-in' AND purpose_account_id IS NULL) OR
    (purpose = 'link' AND purpose_account_id IS NOT NULL)
  ),
  CONSTRAINT oidc_login_transactions_consent_shape CHECK (
    (signup_submission_id IS NULL AND signup_terms_version IS NULL AND
      signup_terms_hash IS NULL AND signup_affirmed IS NULL) OR
    (purpose = 'sign-in' AND signup_submission_id IS NOT NULL AND
      signup_terms_version IS NOT NULL AND signup_terms_hash IS NOT NULL AND
      signup_affirmed IS NOT NULL)
  ),
  CONSTRAINT oidc_login_transactions_account_fk
    FOREIGN KEY (purpose_account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX idx_oidc_login_transactions_expiry
  ON oidc_login_transactions(expires_at_seconds);

CREATE TABLE content_nonce_reservations (
  vault_id text NOT NULL,
  dek_version bigint NOT NULL CHECK (dek_version > 0),
  nonce text NOT NULL CHECK (nonce ~ '^[A-Za-z0-9_-]{16}$'),
  PRIMARY KEY (vault_id, dek_version, nonce),
  CONSTRAINT content_nonce_reservations_key_fk
    FOREIGN KEY (vault_id, dek_version)
    REFERENCES vault_dek_versions(vault_id, dek_version) ON DELETE CASCADE
);

CREATE TABLE limited_access_grants (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  granted_at bigint NOT NULL CHECK (granted_at BETWEEN 0 AND 9007199254740991),
  expires_at bigint NOT NULL CHECK (
    expires_at > granted_at AND expires_at <= 9007199254740991
  ),
  revoked_at bigint CHECK (
    revoked_at >= granted_at AND revoked_at <= 9007199254740991
  ),
  active_cards bigint NOT NULL CHECK (active_cards BETWEEN 1 AND 9007199254740991),
  display_characters_per_card bigint NOT NULL CHECK (
    display_characters_per_card BETWEEN 1 AND 9007199254740991
  ),
  serialized_plaintext_bytes_per_card bigint NOT NULL CHECK (
    serialized_plaintext_bytes_per_card BETWEEN 1 AND 9007199254740991
  ),
  plaintext_bytes_per_vault bigint NOT NULL CHECK (
    plaintext_bytes_per_vault BETWEEN 1 AND 9007199254740991
  ),
  PRIMARY KEY (account_id, vault_id),
  CONSTRAINT limited_access_grants_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE
);

CREATE TABLE feature_flags (
  flag_name text PRIMARY KEY CHECK (
    flag_name ~ '^[a-z][a-z0-9-]{0,63}$'
  ),
  globally_enabled boolean NOT NULL,
  updated_at bigint NOT NULL CHECK (updated_at BETWEEN 0 AND 9007199254740991)
);

CREATE TABLE feature_flag_accounts (
  flag_name text NOT NULL,
  account_id text NOT NULL,
  enabled_at bigint NOT NULL CHECK (enabled_at BETWEEN 0 AND 9007199254740991),
  PRIMARY KEY (flag_name, account_id),
  CONSTRAINT feature_flag_accounts_flag_fk
    FOREIGN KEY (flag_name) REFERENCES feature_flags(flag_name) ON DELETE CASCADE,
  CONSTRAINT feature_flag_accounts_account_fk
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE
);
CREATE INDEX idx_feature_flag_accounts_account
  ON feature_flag_accounts(account_id, flag_name);

INSERT INTO feature_flags(flag_name, globally_enabled, updated_at)
VALUES ('billing-checkout', false, 0);

-- +goose Down
DROP TABLE feature_flag_accounts;
DROP TABLE feature_flags;
DROP TABLE limited_access_grants;
DROP TABLE content_nonce_reservations;
DROP TABLE oidc_login_transactions;
