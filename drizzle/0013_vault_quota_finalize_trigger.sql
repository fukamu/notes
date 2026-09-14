CREATE TRIGGER vault_quota_finalize_usage
    BEFORE UPDATE OF state ON vault_quota_reservations
    FOR EACH ROW
    WHEN OLD.state = 'reserved' AND NEW.state IN ('committed', 'released')
    BEGIN
      UPDATE vault_quota_usage SET
        revision = NEW.finalized_usage_revision,
        active_cards = active_cards + CASE
          WHEN NEW.state = 'committed' THEN NEW.card_delta ELSE 0 END,
        plaintext_bytes = plaintext_bytes + CASE
          WHEN NEW.state = 'committed' THEN NEW.plaintext_byte_delta ELSE 0 END,
        last_transition_reservation_id = NEW.reservation_id,
        updated_at = NEW.finalized_at
      WHERE account_id = NEW.account_id AND vault_id = NEW.vault_id
        AND revision = NEW.finalized_usage_revision - 1
        AND active_cards + CASE
          WHEN NEW.state = 'committed' THEN NEW.card_delta ELSE 0 END >= 0
        AND plaintext_bytes + CASE
          WHEN NEW.state = 'committed' THEN NEW.plaintext_byte_delta ELSE 0 END >= 0;
      SELECT CASE WHEN changes() <> 1 THEN RAISE(IGNORE) END;
    END;
