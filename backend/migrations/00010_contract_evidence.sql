-- +goose Up
CREATE TABLE contract_evidence (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  evidence_id text NOT NULL,
  submission_id text NOT NULL,
  offer_hash text NOT NULL,
  offer_version text NOT NULL,
  disclosure_version text NOT NULL,
  serialized_offer text NOT NULL,
  consent text NOT NULL,
  confirmed_at bigint NOT NULL,
  PRIMARY KEY (account_id, vault_id, evidence_id),
  CONSTRAINT contract_evidence_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id),
  CONSTRAINT contract_evidence_shape_check CHECK (
    account_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND vault_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND evidence_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND submission_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND offer_hash ~ '^sha256:[a-f0-9]{64}$'
    AND offer_version ~ '^legal-commerce-v1:[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND disclosure_version ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
    AND char_length(serialized_offer) BETWEEN 1 AND 8192
    AND consent = 'affirmed'
    AND confirmed_at BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT contract_evidence_submission_unique
    UNIQUE (account_id, vault_id, submission_id)
);
CREATE INDEX idx_contract_evidence_confirmed
  ON contract_evidence(account_id, vault_id, confirmed_at DESC, evidence_id DESC);

-- +goose StatementBegin
CREATE FUNCTION prevent_contract_evidence_update() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'contract evidence is immutable'
    USING ERRCODE = '23514', CONSTRAINT = 'contract_evidence_immutable';
END;
$$;
-- +goose StatementEnd
CREATE TRIGGER contract_evidence_immutable
  BEFORE UPDATE ON contract_evidence
  FOR EACH ROW EXECUTE FUNCTION prevent_contract_evidence_update();

-- +goose Down
DROP TABLE contract_evidence;
DROP FUNCTION prevent_contract_evidence_update();
