-- +goose Up
CREATE TABLE verified_email_owners (
  email text PRIMARY KEY,
  account_id text NOT NULL,
  verified_at bigint NOT NULL CHECK (verified_at >= 0),
  CONSTRAINT verified_email_owners_account_fk
    FOREIGN KEY (account_id) REFERENCES accounts(account_id) ON DELETE CASCADE,
  CONSTRAINT verified_email_owners_shape_check CHECK (
    char_length(email) BETWEEN 3 AND 320
    AND email = btrim(email)
    AND email !~ '[[:space:]]'
    AND email ~ '^[^@]+@[^@]+$'
    AND split_part(email, '@', 2) = lower(split_part(email, '@', 2))
  )
);
CREATE INDEX idx_verified_email_owners_account
  ON verified_email_owners(account_id);

CREATE TABLE signup_admission_reservations (
  submission_id text PRIMARY KEY,
  identity_kind text NOT NULL CHECK (identity_kind IN ('google', 'email-otp')),
  provider text NOT NULL CHECK (provider IN ('google-oidc', 'email-otp')),
  issuer text NOT NULL,
  subject text NOT NULL,
  verified_email text NOT NULL,
  account_id text NOT NULL UNIQUE,
  vault_id text NOT NULL UNIQUE,
  identity_id text NOT NULL UNIQUE,
  session_id text NOT NULL UNIQUE,
  session_epoch bigint NOT NULL CHECK (session_epoch = 1),
  created_at bigint NOT NULL CHECK (created_at >= 0),
  finalized_at bigint,
  terms_consent_id text,
  CONSTRAINT signup_reservations_provider_shape_check CHECK (
    (identity_kind = 'google' AND provider = 'google-oidc') OR
    (identity_kind = 'email-otp' AND provider = 'email-otp' AND issuer = 'fukamu.email-otp')
  ),
  CONSTRAINT signup_reservations_email_shape_check CHECK (
    char_length(verified_email) BETWEEN 3 AND 320
    AND verified_email = btrim(verified_email)
    AND verified_email !~ '[[:space:]]'
    AND verified_email ~ '^[^@]+@[^@]+$'
    AND split_part(verified_email, '@', 2) = lower(split_part(verified_email, '@', 2))
  ),
  CONSTRAINT signup_reservations_finalization_check CHECK (
    (finalized_at IS NULL AND terms_consent_id IS NULL) OR
    (finalized_at >= created_at AND terms_consent_id IS NOT NULL)
  ),
  CONSTRAINT signup_reservations_provider_identity_unique UNIQUE (provider, issuer, subject),
  CONSTRAINT signup_reservations_verified_email_unique UNIQUE (verified_email)
);
CREATE INDEX idx_signup_reservations_finalized
  ON signup_admission_reservations(finalized_at, submission_id);

-- +goose Down
DROP TABLE signup_admission_reservations;
DROP TABLE verified_email_owners;
