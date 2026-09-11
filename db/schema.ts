import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const syncState = sqliteTable(
  'sync_state',
  {
    singleton: integer('singleton').primaryKey(),
    nextDisplayId: integer('next_display_id').notNull(),
  },
  (table) => [
    check('sync_state_singleton_check', sql`${table.singleton} = 1`),
    check('sync_state_next_display_id_check', sql`${table.nextDisplayId} > 0`),
  ],
);

export const cards = sqliteTable(
  'cards',
  {
    id: text('id').primaryKey(),
    displayId: integer('display_id').notNull(),
    title: text('title').notNull(),
    bodyJson: text('body_json').notNull(),
    revision: integer('revision').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    lastMutationId: text('last_mutation_id').notNull(),
  },
  (table) => [
    uniqueIndex('idx_cards_display_id').on(table.displayId),
    check('cards_display_id_check', sql`${table.displayId} > 0`),
    check('cards_revision_check', sql`${table.revision} > 0`),
  ],
);

export const cardMutations = sqliteTable(
  'card_mutations',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_card_mutations_card_id').on(table.cardId)],
);

export const conflicts = sqliteTable(
  'conflicts',
  {
    id: text('id').primaryKey(),
    cardId: text('card_id').notNull(),
    serverRevision: integer('server_revision').notNull(),
    localTitle: text('local_title').notNull(),
    localBodyJson: text('local_body_json').notNull(),
    serverTitle: text('server_title').notNull(),
    serverBodyJson: text('server_body_json').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [index('idx_conflicts_card_id').on(table.cardId)],
);

// Runtime initialization and the checked-in Drizzle migration are deliberately
// compared by tests. Keep valid existing schema semantics stable.
export const syncSchemaStatements = [
  `CREATE TABLE IF NOT EXISTS sync_state (
    singleton INTEGER PRIMARY KEY NOT NULL CONSTRAINT sync_state_singleton_check CHECK (singleton = 1),
    next_display_id INTEGER NOT NULL CONSTRAINT sync_state_next_display_id_check CHECK (next_display_id > 0)
  )`,
  `CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY NOT NULL,
    display_id INTEGER NOT NULL CONSTRAINT cards_display_id_check CHECK (display_id > 0),
    title TEXT NOT NULL,
    body_json TEXT NOT NULL,
    revision INTEGER NOT NULL CONSTRAINT cards_revision_check CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_mutation_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS card_mutations (
    id TEXT PRIMARY KEY NOT NULL,
    card_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY NOT NULL,
    card_id TEXT NOT NULL,
    server_revision INTEGER NOT NULL,
    local_title TEXT NOT NULL,
    local_body_json TEXT NOT NULL,
    server_title TEXT NOT NULL,
    server_body_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_cards_display_id ON cards(display_id)',
  'CREATE INDEX IF NOT EXISTS idx_card_mutations_card_id ON card_mutations(card_id)',
  'CREATE INDEX IF NOT EXISTS idx_conflicts_card_id ON conflicts(card_id)',
  'INSERT OR IGNORE INTO sync_state(singleton, next_display_id) VALUES (1, 1)',
] as const;
