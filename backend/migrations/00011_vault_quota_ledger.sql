-- +goose Up
CREATE TABLE vault_quota_usage (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  revision bigint NOT NULL,
  active_cards bigint NOT NULL,
  plaintext_bytes bigint NOT NULL,
  last_transition_reservation_id text,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (account_id, vault_id),
  CONSTRAINT vault_quota_usage_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_quota_usage_shape_check CHECK (
    revision BETWEEN 1 AND 2147483647
    AND active_cards BETWEEN 0 AND 9007199254740991
    AND plaintext_bytes BETWEEN 0 AND 9007199254740991
    AND (last_transition_reservation_id IS NULL OR
      last_transition_reservation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
    AND created_at BETWEEN 0 AND 9007199254740991
    AND updated_at BETWEEN created_at AND 9007199254740991
  )
);

CREATE TABLE vault_quota_reservations (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  reservation_id text NOT NULL,
  fingerprint text NOT NULL,
  card_id text NOT NULL,
  change_kind text NOT NULL,
  card_delta bigint NOT NULL,
  plaintext_byte_delta bigint NOT NULL,
  charged_card_delta bigint NOT NULL,
  charged_plaintext_byte_delta bigint NOT NULL,
  usage_revision_at_reservation bigint NOT NULL,
  state text NOT NULL,
  created_at bigint NOT NULL,
  reconcile_after bigint NOT NULL,
  finalized_at bigint,
  finalized_usage_revision bigint,
  PRIMARY KEY (account_id, vault_id, reservation_id),
  CONSTRAINT vault_quota_reservations_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_quota_reservations_shape_check CHECK (
    reservation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND fingerprint ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
    AND card_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND usage_revision_at_reservation BETWEEN 1 AND 2147483647
    AND created_at BETWEEN 0 AND 9007199254740991
    AND reconcile_after BETWEEN created_at + 1 AND 9007199254740991
    AND plaintext_byte_delta BETWEEN -9007199254740991 AND 9007199254740991
    AND charged_plaintext_byte_delta BETWEEN 0 AND 9007199254740991
    AND (
      (change_kind = 'create' AND card_delta = 1
        AND plaintext_byte_delta >= 0 AND charged_card_delta = 1
        AND charged_plaintext_byte_delta = plaintext_byte_delta)
      OR
      (change_kind = 'update' AND card_delta = 0 AND charged_card_delta = 0
        AND charged_plaintext_byte_delta = GREATEST(plaintext_byte_delta, 0))
      OR
      (change_kind = 'delete' AND card_delta = -1
        AND plaintext_byte_delta <= 0 AND charged_card_delta = 0
        AND charged_plaintext_byte_delta = 0)
    )
    AND (
      (state = 'reserved' AND finalized_at IS NULL AND finalized_usage_revision IS NULL)
      OR
      (state IN ('committed', 'released')
        AND finalized_at BETWEEN created_at AND 9007199254740991
        AND finalized_usage_revision BETWEEN usage_revision_at_reservation + 1 AND 2147483647)
    )
  )
);
CREATE INDEX idx_vault_quota_reservations_reconcile
  ON vault_quota_reservations(
    account_id, vault_id, state, reconcile_after, reservation_id
  );

-- PostgreSQL finalization uses a single serializable transaction. This empty
-- parity table preserves the D1 assertion-table schema for audits and future
-- data interchange without moving the atomicity boundary out of PostgreSQL.
CREATE TABLE vault_quota_finalization_assertions (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  reservation_id text NOT NULL,
  assertion_passed smallint NOT NULL,
  PRIMARY KEY (account_id, vault_id, reservation_id),
  CONSTRAINT vault_quota_finalization_assertions_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_quota_finalization_assertions_shape_check CHECK (
    reservation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND assertion_passed = 1
  )
);

-- +goose Down
DROP TABLE vault_quota_finalization_assertions;
DROP TABLE vault_quota_reservations;
DROP TABLE vault_quota_usage;
