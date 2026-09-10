import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

export const syncState = sqliteTable('sync_state', {
  singleton: integer('singleton').primaryKey(),
  nextDisplayId: integer('next_display_id').notNull(),
});

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
  (table) => [uniqueIndex('idx_cards_display_id').on(table.displayId)],
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
