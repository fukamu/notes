import type { MigrationDefinition } from '../migrations/core';

export const vaultQuotaLedgerStatements = [
  `CREATE TABLE vault_quota_usage (
    account_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    active_cards INTEGER NOT NULL,
    plaintext_bytes INTEGER NOT NULL,
    last_transition_reservation_id TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, vault_id),
    CONSTRAINT vault_quota_usage_owner_fk FOREIGN KEY (account_id, vault_id) REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
    CONSTRAINT vault_quota_usage_shape_check CHECK (
      revision > 0 AND active_cards >= 0 AND plaintext_bytes >= 0
      AND (last_transition_reservation_id IS NULL OR length(last_transition_reservation_id) = 36)
      AND created_at >= 0 AND updated_at >= created_at
    )
  )`,
  `CREATE TABLE vault_quota_reservations (
    account_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    card_id TEXT NOT NULL,
    change_kind TEXT NOT NULL,
    card_delta INTEGER NOT NULL,
    plaintext_byte_delta INTEGER NOT NULL,
    charged_card_delta INTEGER NOT NULL,
    charged_plaintext_byte_delta INTEGER NOT NULL,
    usage_revision_at_reservation INTEGER NOT NULL,
    state TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    reconcile_after INTEGER NOT NULL,
    finalized_at INTEGER,
    finalized_usage_revision INTEGER,
    PRIMARY KEY (account_id, vault_id, reservation_id),
    CONSTRAINT vault_quota_reservations_owner_fk FOREIGN KEY (account_id, vault_id) REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
    CONSTRAINT vault_quota_reservations_shape_check CHECK (
      length(reservation_id) = 36 AND length(fingerprint) = 43
      AND length(card_id) = 36 AND usage_revision_at_reservation > 0
      AND created_at >= 0 AND reconcile_after > created_at
      AND (
        (change_kind = 'create' AND card_delta = 1
          AND plaintext_byte_delta >= 0 AND charged_card_delta = 1
          AND charged_plaintext_byte_delta = plaintext_byte_delta)
        OR (change_kind = 'update' AND card_delta = 0
          AND charged_card_delta = 0
          AND charged_plaintext_byte_delta = CASE
            WHEN plaintext_byte_delta > 0 THEN plaintext_byte_delta ELSE 0 END)
        OR (change_kind = 'delete' AND card_delta = -1
          AND plaintext_byte_delta <= 0 AND charged_card_delta = 0
          AND charged_plaintext_byte_delta = 0)
      )
      AND (
        (state = 'reserved' AND finalized_at IS NULL
          AND finalized_usage_revision IS NULL)
        OR (state IN ('committed', 'released')
          AND finalized_at >= created_at
          AND finalized_usage_revision > usage_revision_at_reservation)
      )
    )
  )`,
  `CREATE INDEX idx_vault_quota_reservations_reconcile
    ON vault_quota_reservations(account_id, vault_id, state, reconcile_after, reservation_id)`,
  `CREATE TRIGGER vault_quota_finalize_usage
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
    END`,
] as const;

export const vaultQuotaLedgerMigration: MigrationDefinition = {
  id: '0012_vault_quota_ledger',
  checksum:
    'sha256:45daced43da33f3c490cbd80f15d6d52eea2e1bd386bb075b3b3462aedf6072c',
  statements: vaultQuotaLedgerStatements,
};
