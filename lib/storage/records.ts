import {
  arrayDecoder,
  decodeOrThrow,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  refineDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type InferDecoder,
} from '@/lib/codec/core';
import {
  bodyDecoder,
  conflictRecordDecoder,
  CONTRACT_LIMITS,
  displayIdDecoder,
  nonNegativeSafeIntegerDecoder,
  pendingMutationDecoder,
  positiveSafeIntegerDecoder,
  type BodySegment,
  type CardRecord,
  type ConflictRecord,
  type PendingMutation,
} from '@/lib/domain/types';
import {
  cardIdDecoder,
  deviceIdDecoder,
  mutationIdDecoder,
  type DeviceId,
} from '@/lib/domain/id';
import { assertNever } from '@/lib/shared/invariant';
import type { SyncV2Checkpoint } from '@/lib/sync/v2-page-application';
import {
  syncSequenceDecoder,
  syncV2CursorDecoder,
} from '@/lib/sync/v2-protocol';
import type {
  LocalMutationDraft,
  OutgoingBatch,
  OutgoingBatchId,
} from '@/lib/sync/outgoing-batch';
import { legacyMutationDraft } from '@/lib/sync/outgoing-batch';

const storedCardRecordDecoder = objectDecoder({
  id: cardIdDecoder,
  displayId: displayIdDecoder,
  title: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  body: bodyDecoder,
  createdAt: nonNegativeSafeIntegerDecoder,
  updatedAt: nonNegativeSafeIntegerDecoder,
  localRevision: positiveSafeIntegerDecoder,
  serverRevision: nullableDecoder(positiveSafeIntegerDecoder),
});

const storedConflictRecordDecoder = conflictRecordDecoder;
const storedPendingMutationDecoder = pendingMutationDecoder;
const outgoingBatchIdDecoder = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 48, maxLength: 64 }),
    (value) => /^outgoing\.v1\.[0-9a-f-]{36}$/.test(value),
    'expected a versioned outgoing batch ID',
  ),
  (value) => value as OutgoingBatchId,
);
const mutationDraftOriginVersionDecoder = refineDecoder(
  positiveSafeIntegerDecoder,
  (value) => value === 1,
  'expected mutation draft origin version 1',
);
const storedMutationOriginDecoder = objectDecoder({
  version: mutationDraftOriginVersionDecoder,
  baseServerRevision: nullableDecoder(positiveSafeIntegerDecoder),
  predecessorMutationId: nullableDecoder(mutationIdDecoder),
});
const storedMutationDraftDecoder = transformDecoder(
  refineDecoder(
    objectDecoder({
      version: literalDecoder('mutation-draft/v1'),
      cardId: cardIdDecoder,
      mutation: pendingMutationDecoder,
      origin: storedMutationOriginDecoder,
    }),
    (stored) => stored.cardId === stored.mutation.cardId,
    'expected matching stored and mutation card IDs',
  ),
  (stored): LocalMutationDraft => ({
    mutation: stored.mutation,
    origin: { ...stored.origin, version: 1 },
  }),
);
const compatibleStoredMutationDecoder = unionDecoder(
  storedMutationDraftDecoder,
  transformDecoder(storedPendingMutationDecoder, legacyMutationDraft),
);
const storedOutgoingBatchDecoder = transformDecoder(
  objectDecoder({
    key: literalDecoder('outgoing'),
    version: literalDecoder('outgoing-batch/v1'),
    batchId: outgoingBatchIdDecoder,
    deviceId: deviceIdDecoder,
    mutations: arrayDecoder(pendingMutationDecoder, {
      minLength: 1,
      maxLength: CONTRACT_LIMITS.mutations,
      uniqueBy: (mutation) => mutation.cardId,
    }),
  }),
  (stored): OutgoingBatch => ({
    version: 1,
    batchId: stored.batchId,
    deviceId: stored.deviceId,
    mutations: stored.mutations,
  }),
);
const storedMetaRecordDecoder = objectDecoder({
  key: literalDecoder('deviceId'),
  value: deviceIdDecoder,
});
const storedSyncV2CheckpointDecoder = objectDecoder({
  key: literalDecoder('checkpoint'),
  cursor: nullableDecoder(syncV2CursorDecoder),
  highWatermark: syncSequenceDecoder,
});

const storedCardsDecoder = arrayDecoder(storedCardRecordDecoder, {
  maxLength: CONTRACT_LIMITS.cards,
  uniqueBy: (card) => card.id,
});
const storedMutationDraftsDecoder = arrayDecoder(
  compatibleStoredMutationDecoder,
  {
    maxLength: CONTRACT_LIMITS.cards,
    uniqueBy: (draft) => draft.mutation.cardId,
  },
);
const storedConflictsDecoder = arrayDecoder(storedConflictRecordDecoder, {
  maxLength: CONTRACT_LIMITS.conflicts,
  uniqueBy: (conflict) => conflict.id,
});

export type StoredCardRecord = InferDecoder<typeof storedCardRecordDecoder>;
export type StoredPendingMutation = InferDecoder<
  typeof storedPendingMutationDecoder
>;
export type StoredConflictRecord = InferDecoder<
  typeof storedConflictRecordDecoder
>;
export type StoredMetaRecord = InferDecoder<typeof storedMetaRecordDecoder>;
export type StoredSyncV2Checkpoint = InferDecoder<
  typeof storedSyncV2CheckpointDecoder
>;

export function decodeStoredCards(input: unknown): CardRecord[] {
  return decodeOrThrow(storedCardsDecoder, input, 'IndexedDB cards');
}

export function decodeStoredMutations(input: unknown): PendingMutation[] {
  return decodeStoredMutationDrafts(input).map((draft) => draft.mutation);
}

export function decodeStoredMutationDrafts(
  input: unknown,
): LocalMutationDraft[] {
  return decodeOrThrow(
    storedMutationDraftsDecoder,
    input,
    'IndexedDB mutations',
  );
}

export function decodeStoredOutgoingBatch(input: unknown): OutgoingBatch {
  return decodeOrThrow(
    storedOutgoingBatchDecoder,
    input,
    'IndexedDB Sync v2 outgoing batch',
  );
}

export function decodeStoredConflicts(input: unknown): ConflictRecord[] {
  return decodeOrThrow(storedConflictsDecoder, input, 'IndexedDB conflicts');
}

export function decodeStoredMeta(input: unknown): StoredMetaRecord {
  return decodeOrThrow(storedMetaRecordDecoder, input, 'IndexedDB meta');
}

export function decodeStoredSyncV2Checkpoint(
  input: unknown,
): StoredSyncV2Checkpoint {
  return decodeOrThrow(
    storedSyncV2CheckpointDecoder,
    input,
    'IndexedDB Sync v2 checkpoint',
  );
}

function wireString(value: string): string {
  return value;
}

function encodeBody(body: BodySegment[]) {
  return body.map((segment) => {
    switch (segment.type) {
      case 'text':
        return { type: segment.type, text: segment.text };
      case 'link':
        return {
          type: segment.type,
          targetCardId: wireString(segment.targetCardId),
        };
      default:
        return assertNever(segment, 'Unsupported stored body segment');
    }
  });
}

export function encodeStoredCard(card: CardRecord) {
  return {
    id: wireString(card.id),
    displayId: { ...card.displayId },
    title: card.title,
    body: encodeBody(card.body),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    localRevision: card.localRevision,
    serverRevision: card.serverRevision,
  };
}

function encodePendingMutation(mutation: PendingMutation) {
  const base = {
    mutationId: wireString(mutation.mutationId),
    cardId: wireString(mutation.cardId),
    baseServerRevision: mutation.baseServerRevision,
    title: mutation.title,
    body: encodeBody(mutation.body),
    createdAt: mutation.createdAt,
    updatedAt: mutation.updatedAt,
  };
  switch (mutation.kind) {
    case 'upsert':
      return { ...base, kind: mutation.kind, conflictIds: [] };
    case 'resolve':
      return {
        ...base,
        kind: mutation.kind,
        conflictIds: mutation.conflictIds.map(wireString),
      };
    default:
      return assertNever(mutation, 'Unsupported stored mutation');
  }
}

export function encodeStoredMutation(
  mutation: PendingMutation,
  origin = legacyMutationDraft(mutation).origin,
) {
  return {
    version: 'mutation-draft/v1' as const,
    cardId: wireString(mutation.cardId),
    mutation: encodePendingMutation(mutation),
    origin: {
      version: 1 as const,
      baseServerRevision: origin.baseServerRevision,
      predecessorMutationId:
        origin.predecessorMutationId === null
          ? null
          : wireString(origin.predecessorMutationId),
    },
  };
}

export function encodeStoredOutgoingBatch(batch: OutgoingBatch) {
  return {
    key: 'outgoing' as const,
    version: 'outgoing-batch/v1' as const,
    batchId: wireString(batch.batchId),
    deviceId: wireString(batch.deviceId),
    mutations: batch.mutations.map(encodePendingMutation),
  };
}

export function encodeStoredConflict(conflict: ConflictRecord) {
  return {
    id: wireString(conflict.id),
    cardId: wireString(conflict.cardId),
    serverRevision: conflict.serverRevision,
    localTitle: conflict.localTitle,
    localBody: encodeBody(conflict.localBody),
    serverTitle: conflict.serverTitle,
    serverBody: encodeBody(conflict.serverBody),
    createdAt: conflict.createdAt,
  };
}

export function encodeStoredMeta(deviceId: DeviceId) {
  return { key: 'deviceId' as const, value: wireString(deviceId) };
}

export function encodeStoredSyncV2Checkpoint(checkpoint: SyncV2Checkpoint) {
  return {
    key: 'checkpoint' as const,
    cursor: checkpoint.cursor === null ? null : wireString(checkpoint.cursor),
    highWatermark: checkpoint.highWatermark,
  };
}

export type StoredCardWire = ReturnType<typeof encodeStoredCard>;
export type StoredMutationWire = ReturnType<typeof encodeStoredMutation>;
export type StoredConflictWire = ReturnType<typeof encodeStoredConflict>;
export type StoredMetaWire = ReturnType<typeof encodeStoredMeta>;
export type StoredSyncV2CheckpointWire = ReturnType<
  typeof encodeStoredSyncV2Checkpoint
>;
export type StoredOutgoingBatchWire = ReturnType<
  typeof encodeStoredOutgoingBatch
>;
