import type {
  BodySegment,
  ConflictRecord,
  PendingMutation,
} from '@/lib/domain/types';
import { parseCardId, parseConflictId, type MutationId } from '@/lib/domain/id';
import type { ServerCard, SyncResponse } from '@/lib/sync/protocol';

type CardRow = {
  id: string;
  display_id: number;
  title: string;
  body_json: string;
  revision: number;
  created_at: number;
  updated_at: number;
};

type ConflictRow = {
  id: string;
  card_id: string;
  server_revision: number;
  local_title: string;
  local_body_json: string;
  server_title: string;
  server_body_json: string;
  created_at: number;
};

const schemaStatements = [
  `CREATE TABLE IF NOT EXISTS sync_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    next_display_id INTEGER NOT NULL CHECK (next_display_id > 0)
  )`,
  `CREATE TABLE IF NOT EXISTS cards (
    id TEXT PRIMARY KEY,
    display_id INTEGER NOT NULL UNIQUE CHECK (display_id > 0),
    title TEXT NOT NULL,
    body_json TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    last_mutation_id TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS card_mutations (
    id TEXT PRIMARY KEY,
    card_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS conflicts (
    id TEXT PRIMARY KEY,
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

function bodyJson(body: BodySegment[]): string {
  return JSON.stringify(body);
}

function parseBody(value: string): BodySegment[] {
  return JSON.parse(value) as BodySegment[];
}

export async function ensureSyncSchema(database: D1Database): Promise<void> {
  await database.batch(
    schemaStatements.map((statement) => database.prepare(statement)),
  );
}

async function mutationWasApplied(
  database: D1Database,
  mutationId: string,
): Promise<boolean> {
  const existing = await database
    .prepare('SELECT id FROM card_mutations WHERE id = ?')
    .bind(mutationId)
    .first<{ id: string }>();
  return Boolean(existing);
}

async function readCard(
  database: D1Database,
  cardId: string,
): Promise<CardRow | null> {
  return database
    .prepare(
      `SELECT id, display_id, title, body_json, revision, created_at, updated_at
       FROM cards WHERE id = ?`,
    )
    .bind(cardId)
    .first<CardRow>();
}

async function createCard(
  database: D1Database,
  mutation: PendingMutation,
): Promise<void> {
  await database.batch([
    database
      .prepare(
        `INSERT INTO cards(
          id, display_id, title, body_json, revision, created_at, updated_at, last_mutation_id
        ) VALUES (?, (SELECT next_display_id FROM sync_state WHERE singleton = 1), ?, ?, 1, ?, ?, ?)`,
      )
      .bind(
        mutation.cardId,
        mutation.title,
        bodyJson(mutation.body),
        mutation.createdAt,
        mutation.updatedAt,
        mutation.mutationId,
      ),
    database.prepare(
      'UPDATE sync_state SET next_display_id = next_display_id + 1 WHERE singleton = 1',
    ),
    database
      .prepare(
        'INSERT INTO card_mutations(id, card_id, created_at) VALUES (?, ?, ?)',
      )
      .bind(mutation.mutationId, mutation.cardId, Date.now()),
  ]);
}

async function updateCard(
  database: D1Database,
  mutation: PendingMutation,
): Promise<void> {
  if (mutation.kind === 'resolve') {
    const statements = [
      database
        .prepare(
          `UPDATE cards SET title = ?, body_json = ?, revision = revision + 1,
           updated_at = ?, last_mutation_id = ? WHERE id = ?`,
        )
        .bind(
          mutation.title,
          bodyJson(mutation.body),
          mutation.updatedAt,
          mutation.mutationId,
          mutation.cardId,
        ),
      ...mutation.conflictIds.map((conflictId) =>
        database
          .prepare('DELETE FROM conflicts WHERE id = ? AND card_id = ?')
          .bind(conflictId, mutation.cardId),
      ),
      database
        .prepare(
          'INSERT INTO card_mutations(id, card_id, created_at) VALUES (?, ?, ?)',
        )
        .bind(mutation.mutationId, mutation.cardId, Date.now()),
    ];
    await database.batch(statements);
    return;
  }

  const serializedBody = bodyJson(mutation.body);
  await database.batch([
    database
      .prepare(
        `UPDATE cards SET title = ?, body_json = ?, revision = revision + 1,
         updated_at = ?, last_mutation_id = ?
         WHERE id = ? AND (revision = ? OR (title = ? AND body_json = ?))`,
      )
      .bind(
        mutation.title,
        serializedBody,
        mutation.updatedAt,
        mutation.mutationId,
        mutation.cardId,
        mutation.baseServerRevision,
        mutation.title,
        serializedBody,
      ),
    database
      .prepare(
        `INSERT OR IGNORE INTO conflicts(
          id, card_id, server_revision, local_title, local_body_json,
          server_title, server_body_json, created_at
        )
        SELECT ?, id, revision, ?, ?, title, body_json, ?
        FROM cards WHERE id = ? AND last_mutation_id <> ?`,
      )
      .bind(
        mutation.mutationId,
        mutation.title,
        serializedBody,
        Date.now(),
        mutation.cardId,
        mutation.mutationId,
      ),
    database
      .prepare(
        'INSERT INTO card_mutations(id, card_id, created_at) VALUES (?, ?, ?)',
      )
      .bind(mutation.mutationId, mutation.cardId, Date.now()),
  ]);
}

async function applyMutation(
  database: D1Database,
  mutation: PendingMutation,
): Promise<void> {
  if (await mutationWasApplied(database, mutation.mutationId)) return;
  const current = await readCard(database, mutation.cardId);
  if (current) {
    await updateCard(database, mutation);
    return;
  }

  try {
    await createCard(database, mutation);
  } catch (error) {
    const cardCreatedConcurrently = await readCard(database, mutation.cardId);
    if (!cardCreatedConcurrently) throw error;
    await updateCard(database, mutation);
  }
}

export async function synchronize(
  database: D1Database,
  mutations: PendingMutation[],
): Promise<SyncResponse> {
  await ensureSyncSchema(database);
  const acknowledgedMutationIds: MutationId[] = [];
  const ordered = [...mutations].sort(
    (left, right) =>
      left.cardId.localeCompare(right.cardId) ||
      left.mutationId.localeCompare(right.mutationId),
  );

  for (const mutation of ordered) {
    await applyMutation(database, mutation);
    acknowledgedMutationIds.push(mutation.mutationId);
  }

  const cardRows = await database
    .prepare(
      `SELECT id, display_id, title, body_json, revision, created_at, updated_at
       FROM cards ORDER BY display_id ASC`,
    )
    .all<CardRow>();
  const conflictRows = await database
    .prepare(
      `SELECT id, card_id, server_revision, local_title, local_body_json,
       server_title, server_body_json, created_at FROM conflicts ORDER BY created_at ASC`,
    )
    .all<ConflictRow>();

  const cards: ServerCard[] = cardRows.results.map((row) => ({
    id: parseCardId(row.id),
    officialDisplayId: row.display_id,
    title: row.title,
    body: parseBody(row.body_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    revision: row.revision,
  }));
  const conflicts: ConflictRecord[] = conflictRows.results.map((row) => ({
    id: parseConflictId(row.id),
    cardId: parseCardId(row.card_id),
    serverRevision: row.server_revision,
    localTitle: row.local_title,
    localBody: parseBody(row.local_body_json),
    serverTitle: row.server_title,
    serverBody: parseBody(row.server_body_json),
    createdAt: row.created_at,
  }));

  return { cards, conflicts, acknowledgedMutationIds };
}
