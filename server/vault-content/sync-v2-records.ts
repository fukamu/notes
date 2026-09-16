import {
  BoundaryDecodeError,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type InferDecoder,
} from '../../lib/codec/core';
import {
  parseCardId,
  parseConflictId,
  parseMutationId,
} from '../../lib/domain/id';
import { parseSyncSequence } from '../../lib/sync/v2-protocol';
import { contentRevisionDecoder } from './records';
import type {
  SyncV2CardHead,
  SyncV2JournalChange,
  SyncV2JournalReceipt,
} from './sync-v2-public';
import { syncV2MutationFingerprintDecoder } from './sync-v2-public';
import type { SyncV2JournalState } from './sync-v2-core';

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
export const officialDisplayIdDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: 2_147_483_647,
});
const nextSequenceDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
const storedIdentifierDecoder = stringDecoder({ minLength: 36, maxLength: 36 });
const positiveSequenceDecoder = transformDecoder(
  safeIntegerDecoder({ minimum: 1 }),
  parseSyncSequence,
);

export const syncV2JournalStateRowDecoder = objectDecoder({
  next_display_id: officialDisplayIdDecoder,
  next_change_sequence: nextSequenceDecoder,
});

export const syncV2CardHeadRowDecoder = objectDecoder({
  card_id: storedIdentifierDecoder,
  official_display_id: officialDisplayIdDecoder,
  revision: contentRevisionDecoder,
  updated_at: timestampDecoder,
});

export const syncV2JournalReceiptRowDecoder = objectDecoder({
  mutation_id: storedIdentifierDecoder,
  fingerprint: syncV2MutationFingerprintDecoder,
  card_id: storedIdentifierDecoder,
  applied_revision: contentRevisionDecoder,
  committed_at: timestampDecoder,
});

const changeKindDecoder = unionDecoder(
  literalDecoder('card-upsert'),
  literalDecoder('card-tombstone'),
  literalDecoder('conflict-upsert'),
  literalDecoder('conflict-tombstone'),
);

export const syncV2JournalChangeRowDecoder = objectDecoder({
  sequence: positiveSequenceDecoder,
  change_kind: changeKindDecoder,
  card_id: storedIdentifierDecoder,
  conflict_id: nullableDecoder(storedIdentifierDecoder),
  revision: contentRevisionDecoder,
  official_display_id: nullableDecoder(officialDisplayIdDecoder),
  occurred_at: timestampDecoder,
});

type SyncV2JournalStateRow = InferDecoder<typeof syncV2JournalStateRowDecoder>;
type SyncV2CardHeadRow = InferDecoder<typeof syncV2CardHeadRowDecoder>;
type SyncV2JournalReceiptRow = InferDecoder<
  typeof syncV2JournalReceiptRowDecoder
>;
export type SyncV2JournalChangeRow = InferDecoder<
  typeof syncV2JournalChangeRowDecoder
>;

export function mapSyncV2JournalStateRow(
  row: SyncV2JournalStateRow,
): SyncV2JournalState {
  return {
    nextDisplayId: row.next_display_id,
    nextSequence: row.next_change_sequence,
  };
}

export function mapSyncV2CardHeadRow(row: SyncV2CardHeadRow): SyncV2CardHead {
  return {
    cardId: parseCardId(row.card_id),
    officialDisplayId: row.official_display_id,
    revision: row.revision,
    updatedAt: row.updated_at,
  };
}

export function mapSyncV2JournalReceiptRow(
  row: SyncV2JournalReceiptRow,
): SyncV2JournalReceipt {
  return {
    mutationId: parseMutationId(row.mutation_id),
    fingerprint: row.fingerprint,
    cardId: parseCardId(row.card_id),
    appliedRevision: row.applied_revision,
    committedAt: row.committed_at,
  };
}

export function mapSyncV2JournalChangeRow(
  row: SyncV2JournalChangeRow,
): SyncV2JournalChange {
  const cardId = parseCardId(row.card_id);
  switch (row.change_kind) {
    case 'card-upsert':
      if (row.conflict_id !== null || row.official_display_id === null) {
        return invalidChangeRow(row.sequence);
      }
      return {
        kind: row.change_kind,
        sequence: row.sequence,
        cardId,
        officialDisplayId: row.official_display_id,
        revision: row.revision,
        occurredAt: row.occurred_at,
      };
    case 'card-tombstone':
      if (row.conflict_id !== null || row.official_display_id !== null) {
        return invalidChangeRow(row.sequence);
      }
      return {
        kind: row.change_kind,
        sequence: row.sequence,
        cardId,
        revision: row.revision,
        deletedAt: row.occurred_at,
      };
    case 'conflict-upsert':
      if (row.conflict_id === null || row.official_display_id !== null) {
        return invalidChangeRow(row.sequence);
      }
      return {
        kind: row.change_kind,
        sequence: row.sequence,
        conflictId: parseConflictId(row.conflict_id),
        cardId,
        serverRevision: row.revision,
        occurredAt: row.occurred_at,
      };
    case 'conflict-tombstone':
      if (row.conflict_id === null || row.official_display_id !== null) {
        return invalidChangeRow(row.sequence);
      }
      return {
        kind: row.change_kind,
        sequence: row.sequence,
        conflictId: parseConflictId(row.conflict_id),
        cardId,
        serverRevision: row.revision,
        deletedAt: row.occurred_at,
      };
  }
}

function invalidChangeRow(sequence: number): never {
  throw new BoundaryDecodeError('D1 Sync v2 journal change row', [
    { path: ['sequence'], reason: `invalid change shape at ${sequence}` },
  ]);
}
