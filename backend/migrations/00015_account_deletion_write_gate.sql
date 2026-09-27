-- +goose Up
-- A Vault mutation and account-deletion start share the Personal Vault row as
-- their serialization point. If the mutation acquires the lock first, the
-- deletion start waits and its later purge observes the committed mutation. If
-- deletion acquires it first, the mutation observes the durable deletion
-- operation and is rejected before it can recreate live data.
-- +goose StatementBegin
CREATE FUNCTION reject_vault_write_during_account_deletion() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  owner_account_id text;
BEGIN
  SELECT account_id INTO owner_account_id
    FROM personal_vaults
   WHERE vault_id = NEW.vault_id
   FOR KEY SHARE;

  IF owner_account_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM account_deletion_operations
     WHERE account_id = owner_account_id AND vault_id = NEW.vault_id
  ) THEN
    RAISE EXCEPTION 'vault write is blocked by account deletion'
      USING ERRCODE = '23514', CONSTRAINT = 'account_deletion_write_gate';
  END IF;
  RETURN NEW;
END;
$$;
-- +goose StatementEnd

CREATE TRIGGER account_deletion_write_gate_dek_versions
  BEFORE INSERT OR UPDATE ON vault_dek_versions
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_encrypted_objects
  BEFORE INSERT OR UPDATE ON vault_encrypted_objects
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_encrypted_write_intents
  BEFORE INSERT OR UPDATE ON vault_encrypted_write_intents
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_dek_rotation
  BEFORE INSERT OR UPDATE ON vault_dek_rotation_operations
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_reencryption
  BEFORE INSERT OR UPDATE ON vault_reencryption_jobs
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_quota_usage
  BEFORE INSERT OR UPDATE ON vault_quota_usage
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_quota_reservations
  BEFORE INSERT OR UPDATE ON vault_quota_reservations
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_quota_assertions
  BEFORE INSERT OR UPDATE ON vault_quota_finalization_assertions
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_sync_states
  BEFORE INSERT OR UPDATE ON vault_sync_v2_states
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_sync_cards
  BEFORE INSERT OR UPDATE ON vault_sync_v2_cards
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_sync_conflicts
  BEFORE INSERT OR UPDATE ON vault_sync_v2_conflicts
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_sync_commits
  BEFORE INSERT OR UPDATE ON vault_sync_v2_commits
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();
CREATE TRIGGER account_deletion_write_gate_sync_changes
  BEFORE INSERT OR UPDATE ON vault_sync_v2_changes
  FOR EACH ROW EXECUTE FUNCTION reject_vault_write_during_account_deletion();

-- +goose Down
DROP TRIGGER account_deletion_write_gate_sync_changes ON vault_sync_v2_changes;
DROP TRIGGER account_deletion_write_gate_sync_commits ON vault_sync_v2_commits;
DROP TRIGGER account_deletion_write_gate_sync_conflicts ON vault_sync_v2_conflicts;
DROP TRIGGER account_deletion_write_gate_sync_cards ON vault_sync_v2_cards;
DROP TRIGGER account_deletion_write_gate_sync_states ON vault_sync_v2_states;
DROP TRIGGER account_deletion_write_gate_quota_assertions ON vault_quota_finalization_assertions;
DROP TRIGGER account_deletion_write_gate_quota_reservations ON vault_quota_reservations;
DROP TRIGGER account_deletion_write_gate_quota_usage ON vault_quota_usage;
DROP TRIGGER account_deletion_write_gate_reencryption ON vault_reencryption_jobs;
DROP TRIGGER account_deletion_write_gate_dek_rotation ON vault_dek_rotation_operations;
DROP TRIGGER account_deletion_write_gate_encrypted_write_intents ON vault_encrypted_write_intents;
DROP TRIGGER account_deletion_write_gate_encrypted_objects ON vault_encrypted_objects;
DROP TRIGGER account_deletion_write_gate_dek_versions ON vault_dek_versions;
DROP FUNCTION reject_vault_write_during_account_deletion();
