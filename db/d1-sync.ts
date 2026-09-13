import {
  cardRowDecoder,
  conflictRowDecoder,
  decodeD1Results,
  decodeMutationMarker,
  mapCardRow,
  mapConflictRow,
} from '@/db/d1-records';
import { BoundaryDecodeError } from '@/lib/codec/core';
import type { MutationId } from '@/lib/domain/id';
import { CONTRACT_LIMITS, type PendingMutation } from '@/lib/domain/types';
import { decodeSyncResponse, type SyncResponse } from '@/lib/sync/protocol';

export class InvalidResolveError extends Error {
  constructor() {
    super('Resolve preconditions were not satisfied');
    this.name = 'InvalidResolveError';
  }
}

function bodyJson(mutation: PendingMutation): string {
  const value = JSON.stringify(mutation.body);
  if (value.length > CONTRACT_LIMITS.serializedBody) {
    throw new BoundaryDecodeError('D1 body JSON', [
      { path: ['body'], reason: 'serialized body exceeds storage limit' },
    ]);
  }
  return value;
}

async function mutationWasApplied(
  database: D1Database,
  mutationId: MutationId,
): Promise<boolean> {
  const input: unknown = await database
    .prepare('SELECT id FROM card_mutations WHERE id = ?')
    .bind(mutationId)
    .first();
  return decodeMutationMarker(input) !== null;
}

async function readCard(database: D1Database, mutation: PendingMutation) {
  const input: unknown = await database
    .prepare(
      `SELECT id, display_id, title, body_json, revision, created_at, updated_at,
       last_mutation_id FROM cards WHERE id = ?`,
    )
    .bind(mutation.cardId)
    .first();
  if (input === null) return null;
  return mapCardRow(input);
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
        bodyJson(mutation),
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
      .bind(mutation.mutationId, mutation.cardId, mutation.updatedAt),
  ]);
}

async function resolveCard(
  database: D1Database,
  mutation: Extract<PendingMutation, { kind: 'resolve' }>,
): Promise<void> {
  const placeholders = mutation.conflictIds.map(() => '?').join(', ');
  const result = await database.batch([
    database
      .prepare(
        `UPDATE cards SET title = ?, body_json = ?, revision = revision + 1,
         updated_at = ?, last_mutation_id = ?
         WHERE id = ? AND revision = ?
         AND (SELECT COUNT(*) FROM conflicts
              WHERE card_id = ? AND id IN (${placeholders})) = ?`,
      )
      .bind(
        mutation.title,
        bodyJson(mutation),
        mutation.updatedAt,
        mutation.mutationId,
        mutation.cardId,
        mutation.baseServerRevision,
        mutation.cardId,
        ...mutation.conflictIds,
        mutation.conflictIds.length,
      ),
    database
      .prepare(
        `DELETE FROM conflicts WHERE card_id = ? AND id IN (${placeholders})
         AND EXISTS (
           SELECT 1 FROM cards WHERE id = ? AND last_mutation_id = ?
         )`,
      )
      .bind(
        mutation.cardId,
        ...mutation.conflictIds,
        mutation.cardId,
        mutation.mutationId,
      ),
    database
      .prepare(
        `INSERT INTO card_mutations(id, card_id, created_at)
         SELECT ?, ?, ? WHERE EXISTS (
           SELECT 1 FROM cards WHERE id = ? AND last_mutation_id = ?
         )`,
      )
      .bind(
        mutation.mutationId,
        mutation.cardId,
        mutation.updatedAt,
        mutation.cardId,
        mutation.mutationId,
      ),
  ]);

  if (result[0]?.meta.changes !== 1) throw new InvalidResolveError();
}

async function updateCard(
  database: D1Database,
  mutation: PendingMutation,
): Promise<void> {
  if (mutation.kind === 'resolve') {
    await resolveCard(database, mutation);
    return;
  }

  const serializedBody = bodyJson(mutation);
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
        mutation.updatedAt,
        mutation.cardId,
        mutation.mutationId,
      ),
    database
      .prepare(
        'INSERT INTO card_mutations(id, card_id, created_at) VALUES (?, ?, ?)',
      )
      .bind(mutation.mutationId, mutation.cardId, mutation.updatedAt),
  ]);
}

async function applyMutation(
  database: D1Database,
  mutation: PendingMutation,
): Promise<void> {
  if (await mutationWasApplied(database, mutation.mutationId)) return;
  const current = await readCard(database, mutation);
  if (current) {
    await updateCard(database, mutation);
    return;
  }

  try {
    await createCard(database, mutation);
  } catch (error) {
    const cardCreatedConcurrently = await readCard(database, mutation);
    if (!cardCreatedConcurrently) throw error;
    await updateCard(database, mutation);
  }
}

export async function synchronize(
  database: D1Database,
  mutations: PendingMutation[],
): Promise<SyncResponse> {
  await readSyncState(database, [], []);
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

  return readSyncState(database, acknowledgedMutationIds, mutations);
}

async function readSyncState(
  database: D1Database,
  acknowledgedMutationIds: MutationId[],
  sentMutations: PendingMutation[],
): Promise<SyncResponse> {
  const cardResult: unknown = await database
    .prepare(
      `SELECT id, display_id, title, body_json, revision, created_at, updated_at,
       last_mutation_id FROM cards ORDER BY display_id ASC`,
    )
    .all();
  const conflictResult: unknown = await database
    .prepare(
      `SELECT id, card_id, server_revision, local_title, local_body_json,
       server_title, server_body_json, created_at
       FROM conflicts ORDER BY created_at ASC`,
    )
    .all();

  const cardRows = decodeD1Results(
    cardResult,
    cardRowDecoder,
    CONTRACT_LIMITS.cards,
    'D1 card results',
  );
  const conflictRows = decodeD1Results(
    conflictResult,
    conflictRowDecoder,
    CONTRACT_LIMITS.conflicts,
    'D1 conflict results',
  );

  const candidate: unknown = {
    cards: cardRows.map(mapCardRow),
    conflicts: conflictRows.map(mapConflictRow),
    acknowledgedMutationIds,
  };
  return decodeSyncResponse(candidate, sentMutations);
}
