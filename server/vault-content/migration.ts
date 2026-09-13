import type { MigrationDefinition } from '../migrations/core';

export const vaultContentStatements = [
  `CREATE TABLE vault_partition_mappings (
    vault_id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    partition_id TEXT NOT NULL,
    routing_revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CONSTRAINT vault_partition_mappings_partition_check CHECK (length(partition_id) BETWEEN 1 AND 64),
    CONSTRAINT vault_partition_mappings_revision_check CHECK (routing_revision > 0),
    CONSTRAINT vault_partition_mappings_updated_at_check CHECK (updated_at >= 0)
  )`,
  'CREATE UNIQUE INDEX idx_vault_partition_mappings_owner ON vault_partition_mappings(account_id, vault_id)',
  'CREATE INDEX idx_vault_partition_mappings_partition_vault ON vault_partition_mappings(partition_id, vault_id)',
  `CREATE TABLE vault_cards (
    vault_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    revision INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, card_id),
    CONSTRAINT vault_cards_route_fk FOREIGN KEY (vault_id) REFERENCES vault_partition_mappings(vault_id) ON DELETE CASCADE,
    CONSTRAINT vault_cards_revision_check CHECK (revision > 0),
    CONSTRAINT vault_cards_updated_at_check CHECK (updated_at >= 0)
  )`,
  'CREATE INDEX idx_vault_cards_updated ON vault_cards(vault_id, updated_at, card_id)',
  `CREATE TABLE vault_mutation_receipts (
    vault_id TEXT NOT NULL,
    mutation_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    applied_revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, mutation_id),
    CONSTRAINT vault_mutation_receipts_card_fk FOREIGN KEY (vault_id, card_id) REFERENCES vault_cards(vault_id, card_id) ON DELETE CASCADE,
    CONSTRAINT vault_mutation_receipts_revision_check CHECK (applied_revision > 0),
    CONSTRAINT vault_mutation_receipts_created_at_check CHECK (created_at >= 0)
  )`,
  'CREATE INDEX idx_vault_mutation_receipts_card ON vault_mutation_receipts(vault_id, card_id, mutation_id)',
  `CREATE TABLE vault_conflicts (
    vault_id TEXT NOT NULL,
    conflict_id TEXT NOT NULL,
    card_id TEXT NOT NULL,
    server_revision INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (vault_id, conflict_id),
    CONSTRAINT vault_conflicts_card_fk FOREIGN KEY (vault_id, card_id) REFERENCES vault_cards(vault_id, card_id) ON DELETE CASCADE,
    CONSTRAINT vault_conflicts_revision_check CHECK (server_revision > 0),
    CONSTRAINT vault_conflicts_created_at_check CHECK (created_at >= 0)
  )`,
  'CREATE INDEX idx_vault_conflicts_card ON vault_conflicts(vault_id, card_id, conflict_id)',
] as const;

export const vaultContentMigration: MigrationDefinition = {
  id: '0003_vault_partition_content_index',
  checksum:
    'sha256:076e0130cff40bd3627cd0246e2317717a7da6bc6d2c656cc083c1209dbe1c88',
  statements: vaultContentStatements,
};
