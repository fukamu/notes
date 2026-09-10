import {
  arrayDecoder,
  decodeOrThrow,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type InferDecoder,
} from '@/lib/codec/core';
import {
  cardIdDecoder,
  conflictIdDecoder,
  mutationIdDecoder,
  type ConflictId,
} from '@/lib/domain/id';
import { invariant } from '@/lib/shared/invariant';

export const CONTRACT_LIMITS = {
  bodySegments: 10_000,
  cards: 100_000,
  conflictIds: 500,
  conflicts: 100_000,
  mutations: 500,
  text: 100_000,
  title: 10_000,
} as const;

export const positiveSafeIntegerDecoder = safeIntegerDecoder({ minimum: 1 });
export const nonNegativeSafeIntegerDecoder = safeIntegerDecoder({ minimum: 0 });

const provisionalDisplayIdDecoder = objectDecoder({
  kind: literalDecoder('provisional'),
  value: positiveSafeIntegerDecoder,
});
const officialDisplayIdDecoder = objectDecoder({
  kind: literalDecoder('official'),
  value: positiveSafeIntegerDecoder,
});
export const displayIdDecoder = unionDecoder(
  provisionalDisplayIdDecoder,
  officialDisplayIdDecoder,
);

const textSegmentDecoder = objectDecoder({
  type: literalDecoder('text'),
  text: stringDecoder({ maxLength: CONTRACT_LIMITS.text }),
});
const cardLinkSegmentDecoder = objectDecoder({
  type: literalDecoder('link'),
  targetCardId: cardIdDecoder,
});
export const bodySegmentDecoder = unionDecoder(
  textSegmentDecoder,
  cardLinkSegmentDecoder,
);
export const bodyDecoder = arrayDecoder(bodySegmentDecoder, {
  maxLength: CONTRACT_LIMITS.bodySegments,
});

export const cardRecordDecoder = objectDecoder({
  id: cardIdDecoder,
  displayId: displayIdDecoder,
  title: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  body: bodyDecoder,
  createdAt: nonNegativeSafeIntegerDecoder,
  updatedAt: nonNegativeSafeIntegerDecoder,
  localRevision: positiveSafeIntegerDecoder,
  serverRevision: nullableDecoder(positiveSafeIntegerDecoder),
});

export const conflictRecordDecoder = objectDecoder({
  id: conflictIdDecoder,
  cardId: cardIdDecoder,
  serverRevision: positiveSafeIntegerDecoder,
  localTitle: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  localBody: bodyDecoder,
  serverTitle: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  serverBody: bodyDecoder,
  createdAt: nonNegativeSafeIntegerDecoder,
});

const emptyConflictIdsDecoder = transformDecoder(
  arrayDecoder(conflictIdDecoder, { maxLength: 0 }),
  (): [] => [],
);
const nonEmptyConflictIdsDecoder = transformDecoder(
  arrayDecoder(conflictIdDecoder, {
    minLength: 1,
    maxLength: CONTRACT_LIMITS.conflictIds,
    uniqueBy: (id) => id,
  }),
  (ids): [ConflictId, ...ConflictId[]] => {
    const [first, ...rest] = ids;
    invariant(first, 'Non-empty conflict ID decoder returned no values');
    return [first, ...rest];
  },
);

const mutationBase = {
  mutationId: mutationIdDecoder,
  cardId: cardIdDecoder,
  baseServerRevision: nullableDecoder(positiveSafeIntegerDecoder),
  title: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  body: bodyDecoder,
  createdAt: nonNegativeSafeIntegerDecoder,
  updatedAt: nonNegativeSafeIntegerDecoder,
} as const;

const upsertMutationDecoder = objectDecoder({
  ...mutationBase,
  kind: literalDecoder('upsert'),
  conflictIds: emptyConflictIdsDecoder,
});
const resolveMutationDecoder = objectDecoder({
  ...mutationBase,
  kind: literalDecoder('resolve'),
  conflictIds: nonEmptyConflictIdsDecoder,
});
export const pendingMutationDecoder = unionDecoder(
  upsertMutationDecoder,
  resolveMutationDecoder,
);

export type DisplayId = InferDecoder<typeof displayIdDecoder>;
export type TextSegment = InferDecoder<typeof textSegmentDecoder>;
export type CardLinkSegment = InferDecoder<typeof cardLinkSegmentDecoder>;
export type BodySegment = InferDecoder<typeof bodySegmentDecoder>;
export type CardRecord = InferDecoder<typeof cardRecordDecoder>;
export type ConflictRecord = InferDecoder<typeof conflictRecordDecoder>;
export type PendingMutation = InferDecoder<typeof pendingMutationDecoder>;

export function decodeBody(input: unknown): BodySegment[] {
  return decodeOrThrow(bodyDecoder, input, 'Body');
}

export function decodeCardRecord(input: unknown): CardRecord {
  return decodeOrThrow(cardRecordDecoder, input, 'CardRecord');
}

export function decodeConflictRecord(input: unknown): ConflictRecord {
  return decodeOrThrow(conflictRecordDecoder, input, 'ConflictRecord');
}

export function decodePendingMutation(input: unknown): PendingMutation {
  return decodeOrThrow(pendingMutationDecoder, input, 'PendingMutation');
}

export function positiveSafeInteger(input: unknown, context: string): number {
  return decodeOrThrow(positiveSafeIntegerDecoder, input, context);
}

export function nonNegativeSafeInteger(
  input: unknown,
  context: string,
): number {
  return decodeOrThrow(nonNegativeSafeIntegerDecoder, input, context);
}

export type SaveState = 'saved' | 'saving' | 'failed';
export type SyncState = 'idle' | 'syncing' | 'offline' | 'failed';

export function visibleTitle(title: string): string {
  return title.trim() === '' ? 'Untitled' : title;
}
