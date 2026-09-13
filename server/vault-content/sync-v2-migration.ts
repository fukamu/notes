import type { MigrationDefinition } from '../migrations/core';

export const syncV2JournalStatements = [
  `CREATE TABLE vault_sync_v2_states (
    vault_id TEXT PRIMARY KEY NOT NULL,
    next_display_id INTEGER NOT NULL,
    next_change_sequence INTEGER NOT NULL,
    CONSTRAINT vault_sync_v2_states_route_fk FOREIGN KEY (vault_id) REFERENCES vault_partition_mappings(vault_id) ON DELETE CASCADE,
    CONSTRAINT vault_sync_v2_states_display_check CHECK (next_display_id > 0),
    CONSTRAINT vault_sync_v2_states_sequence_check CHECK (next_change_sequence > 0)
  )`,
  `CREATE TABLE vault_card_display_ids (
    vault_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    official_display_id INTEGER NOT NULL,
    PRIMARY KEY (vault_id, card_id),
    CONSTRAINT vault_card_display_ids_card_fk FOREIGN KEY (vault_id, card_id) REFERENCES vault_cards(vault_id, card_id) ON DELETE CASCADE,
    CONSTRAINT vault_card_display_ids_value_check CHECK (official_display_id > 0)
  )`,
  'CREATE UNIQUE INDEX idx_vault_card_display_ids_official ON vault_card_display_ids(vault_id, official_display_id)',
  `CREATE TABLE vault_sync_v2_commits (
    vault_id TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    card_id TEXT NOT NULL,
    applied_revision INTEGER NOT NULL,
    committed_at INTEGER NOT NULL,
    state TEXT NOT NULL,
    PRIMARY KEY (vault_id, mutation_id),
    CONSTRAINT vault_sync_v2_commits_route_fk FOREIGN KEY (vault_id) REFERENCES vault_partition_mappings(vault_id) ON DELETE CASCADE,
    CONSTRAINT vault_sync_v2_commits_shape_check CHECK (
      length(fingerprint) = 43 AND applied_revision > 0
      AND committed_at >= 0 AND state IN ('pending', 'committed')
    )
  )`,
  `CREATE TABLE vault_sync_v2_changes (
    vault_id TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    change_kind TEXT NOT NULL,
    card_id TEXT NOT NULL,
    conflict_id TEXT,
    revision INTEGER NOT NULL,
    official_display_id INTEGER,
    occurred_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, sequence),
    CONSTRAINT vault_sync_v2_changes_state_fk FOREIGN KEY (vault_id) REFERENCES vault_sync_v2_states(vault_id) ON DELETE CASCADE,
    CONSTRAINT vault_sync_v2_changes_shape_check CHECK (
      sequence > 0 AND revision > 0 AND occurred_at >= 0 AND (
        (change_kind = 'card-upsert' AND conflict_id IS NULL AND official_display_id > 0)
        OR (change_kind = 'card-tombstone' AND conflict_id IS NULL AND official_display_id IS NULL)
        OR (change_kind IN ('conflict-upsert', 'conflict-tombstone') AND conflict_id IS NOT NULL AND official_display_id IS NULL)
      )
    )
  )`,
] as const;

export const syncV2JournalMigration: MigrationDefinition = {
  id: '0008_vault_sync_v2_journal',
  checksum:
    'sha256:a4bd175b9c7fe5fef7439001a41952d7296f3de269616fb450c3aa8b4eb66db4',
  statements: syncV2JournalStatements,
};
