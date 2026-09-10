import {
  arrayDecoder,
  decodeOrThrow,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  stringDecoder,
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
import { cardIdDecoder, deviceIdDecoder, type DeviceId } from '@/lib/domain/id';
import { assertNever } from '@/lib/shared/invariant';

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
const storedMetaRecordDecoder = objectDecoder({
  key: literalDecoder('deviceId'),
  value: deviceIdDecoder,
});

const storedCardsDecoder = arrayDecoder(storedCardRecordDecoder, {
  maxLength: CONTRACT_LIMITS.cards,
  uniqueBy: (card) => card.id,
});
const storedMutationsDecoder = arrayDecoder(storedPendingMutationDecoder, {
  maxLength: CONTRACT_LIMITS.cards,
  uniqueBy: (mutation) => mutation.cardId,
});
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

export function decodeStoredCards(input: unknown): CardRecord[] {
  return decodeOrThrow(storedCardsDecoder, input, 'IndexedDB cards');
}

export function decodeStoredMutations(input: unknown): PendingMutation[] {
  return decodeOrThrow(storedMutationsDecoder, input, 'IndexedDB mutations');
}

export function decodeStoredConflicts(input: unknown): ConflictRecord[] {
  return decodeOrThrow(storedConflictsDecoder, input, 'IndexedDB conflicts');
}

export function decodeStoredMeta(input: unknown): StoredMetaRecord {
  return decodeOrThrow(storedMetaRecordDecoder, input, 'IndexedDB meta');
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

export function encodeStoredMutation(mutation: PendingMutation) {
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

export type StoredCardWire = ReturnType<typeof encodeStoredCard>;
export type StoredMutationWire = ReturnType<typeof encodeStoredMutation>;
export type StoredConflictWire = ReturnType<typeof encodeStoredConflict>;
export type StoredMetaWire = ReturnType<typeof encodeStoredMeta>;
