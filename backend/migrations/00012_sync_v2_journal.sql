-- +goose Up
CREATE TABLE vault_sync_v2_states (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  next_display_id bigint NOT NULL,
  next_change_sequence bigint NOT NULL,
  PRIMARY KEY (account_id, vault_id),
  CONSTRAINT vault_sync_v2_states_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_sync_v2_states_shape_check CHECK (
    next_display_id BETWEEN 1 AND 2147483647
    AND next_change_sequence BETWEEN 1 AND 9007199254740991
  )
);

CREATE TABLE vault_sync_v2_cards (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  card_id text NOT NULL,
  official_display_id bigint NOT NULL,
  revision bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (account_id, vault_id, card_id),
  CONSTRAINT vault_sync_v2_cards_state_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES vault_sync_v2_states(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_sync_v2_cards_shape_check CHECK (
    card_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND official_display_id BETWEEN 1 AND 2147483647
    AND revision BETWEEN 1 AND 2147483647
    AND updated_at BETWEEN 0 AND 9007199254740991
  ),
  CONSTRAINT vault_sync_v2_cards_display_unique
    UNIQUE (account_id, vault_id, official_display_id)
);

CREATE TABLE vault_sync_v2_conflicts (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  conflict_id text NOT NULL,
  card_id text NOT NULL,
  server_revision bigint NOT NULL,
  created_at bigint NOT NULL,
  PRIMARY KEY (account_id, vault_id, conflict_id),
  CONSTRAINT vault_sync_v2_conflicts_card_fk
    FOREIGN KEY (account_id, vault_id, card_id)
    REFERENCES vault_sync_v2_cards(account_id, vault_id, card_id) ON DELETE CASCADE,
  CONSTRAINT vault_sync_v2_conflicts_shape_check CHECK (
    conflict_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND card_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND server_revision BETWEEN 1 AND 2147483647
    AND created_at BETWEEN 0 AND 9007199254740991
  )
);
CREATE INDEX idx_vault_sync_v2_conflicts_card
  ON vault_sync_v2_conflicts(account_id, vault_id, card_id, conflict_id);

CREATE TABLE vault_sync_v2_commits (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  mutation_id text NOT NULL,
  fingerprint text NOT NULL,
  card_id text NOT NULL,
  applied_revision bigint NOT NULL,
  committed_at bigint NOT NULL,
  PRIMARY KEY (account_id, vault_id, mutation_id),
  CONSTRAINT vault_sync_v2_commits_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_sync_v2_commits_shape_check CHECK (
    mutation_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND fingerprint ~ '^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$'
    AND card_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND applied_revision BETWEEN 1 AND 2147483647
    AND committed_at BETWEEN 0 AND 9007199254740991
  )
);

CREATE TABLE vault_sync_v2_changes (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  sequence bigint NOT NULL,
  change_kind text NOT NULL,
  card_id text NOT NULL,
  conflict_id text,
  revision bigint NOT NULL,
  official_display_id bigint,
  occurred_at bigint NOT NULL,
  PRIMARY KEY (account_id, vault_id, sequence),
  CONSTRAINT vault_sync_v2_changes_state_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES vault_sync_v2_states(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT vault_sync_v2_changes_shape_check CHECK (
    sequence BETWEEN 1 AND 9007199254740991
    AND card_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND revision BETWEEN 1 AND 2147483647
    AND occurred_at BETWEEN 0 AND 9007199254740991
    AND (
      (change_kind = 'card-upsert' AND conflict_id IS NULL
        AND official_display_id BETWEEN 1 AND 2147483647)
      OR (change_kind = 'card-tombstone' AND conflict_id IS NULL
        AND official_display_id IS NULL)
      OR (change_kind IN ('conflict-upsert', 'conflict-tombstone')
        AND conflict_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        AND official_display_id IS NULL)
    )
  )
);

-- +goose Down
DROP TABLE vault_sync_v2_changes;
DROP TABLE vault_sync_v2_commits;
DROP TABLE vault_sync_v2_conflicts;
DROP TABLE vault_sync_v2_cards;
DROP TABLE vault_sync_v2_states;
