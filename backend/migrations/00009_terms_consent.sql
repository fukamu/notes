-- +goose Up
CREATE TABLE terms_consent_evidence (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  consent_id text NOT NULL,
  submission_id text NOT NULL,
  terms_version text NOT NULL,
  terms_hash text NOT NULL,
  serialized_terms text NOT NULL,
  consent text NOT NULL,
  accepted_at bigint NOT NULL,
  PRIMARY KEY (account_id, vault_id, consent_id),
  CONSTRAINT terms_consent_shape_check CHECK (
    account_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND vault_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND consent_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND submission_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND terms_version ~ '^terms-v1:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND terms_hash ~ '^sha256:[a-f0-9]{64}$'
    AND char_length(serialized_terms) BETWEEN 1 AND 65536
    AND consent = 'affirmed'
    AND accepted_at BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT terms_consent_submission_unique
    UNIQUE (account_id, vault_id, submission_id)
);
CREATE INDEX idx_terms_consent_latest
  ON terms_consent_evidence(account_id, vault_id, accepted_at DESC, consent_id DESC);

-- +goose StatementBegin
CREATE FUNCTION enforce_terms_consent_owner() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM personal_vaults
    WHERE account_id = NEW.account_id AND vault_id = NEW.vault_id
  ) OR EXISTS (
    SELECT 1 FROM signup_admission_reservations
    WHERE submission_id = NEW.submission_id
      AND account_id = NEW.account_id AND vault_id = NEW.vault_id
  ) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'terms consent owner or reservation is missing'
    USING ERRCODE = '23503', CONSTRAINT = 'terms_consent_owner_or_reservation';
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER terms_consent_owner_or_reservation
  BEFORE INSERT ON terms_consent_evidence
  FOR EACH ROW EXECUTE FUNCTION enforce_terms_consent_owner();

-- +goose StatementBegin
CREATE FUNCTION prevent_terms_consent_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'terms consent evidence is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'terms_consent_immutable';
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER terms_consent_immutable
  BEFORE UPDATE ON terms_consent_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_terms_consent_update();

-- +goose Down
DROP TABLE terms_consent_evidence;
DROP FUNCTION prevent_terms_consent_update();
DROP FUNCTION enforce_terms_consent_owner();
