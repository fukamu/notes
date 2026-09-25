-- +goose Up
-- Legal evidence and account-deletion start share the Personal Vault row as
-- their serialization point. Evidence committed first remains visible to the
-- finalization policy gate. Once deletion starts, later evidence cannot appear
-- between the policy check and wrapped-key removal.
-- +goose StatementBegin
CREATE FUNCTION reject_legal_evidence_during_account_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_account_id text;
BEGIN
  SELECT account_id INTO owner_account_id
    FROM personal_vaults
   WHERE account_id = NEW.account_id AND vault_id = NEW.vault_id
   FOR KEY SHARE;

  IF owner_account_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM account_deletion_operations
     WHERE account_id = NEW.account_id AND vault_id = NEW.vault_id
  ) THEN
    RAISE EXCEPTION 'legal evidence write is blocked by account deletion'
      USING ERRCODE = '23514', CONSTRAINT = 'account_deletion_legal_evidence_gate';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER account_deletion_legal_evidence_gate_terms
  BEFORE INSERT ON terms_consent_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_legal_evidence_during_account_deletion();
CREATE TRIGGER account_deletion_legal_evidence_gate_contract
  BEFORE INSERT ON contract_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_legal_evidence_during_account_deletion();

-- +goose Down
DROP TRIGGER account_deletion_legal_evidence_gate_contract ON contract_evidence;
DROP TRIGGER account_deletion_legal_evidence_gate_terms ON terms_consent_evidence;
DROP FUNCTION reject_legal_evidence_during_account_deletion();
