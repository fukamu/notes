import {
  arrayDecoder,
  decodeOrThrow,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
  type InferDecoder,
} from '../codec/core';
import {
  cardIdDecoder,
  conflictIdDecoder,
  mutationIdDecoder,
  type CardId,
  type ConflictId,
  type MutationId,
} from './id';
import { invariant } from '../shared/invariant';

export const CONTRACT_LIMITS = {
  bodySegments: 10_000,
  cards: 100_000,
  conflictIds: 500,
  conflicts: 100_000,
  mutations: 500,
  payloadBytes: 4_000_000,
  serializedBody: 2_000_000,
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

export type TextSegment = {
  type: 'text';
  text: string;
};

export type CardLinkSegment = {
  type: 'link';
  targetCardId: CardId;
};

export type BodySegment = TextSegment | CardLinkSegment;

type PendingMutationBase = {
  mutationId: MutationId;
  cardId: CardId;
  title: string;
  body: BodySegment[];
  createdAt: number;
  updatedAt: number;
};

export type PendingMutation =
  | (PendingMutationBase & {
      kind: 'upsert';
      baseServerRevision: number | null;
      conflictIds: [];
    })
  | (PendingMutationBase & {
      kind: 'resolve';
      baseServerRevision: number;
      conflictIds: [ConflictId, ...ConflictId[]];
    });

const textSegmentDecoder: Decoder<TextSegment> = objectDecoder({
  type: literalDecoder('text'),
  text: stringDecoder({ maxLength: CONTRACT_LIMITS.text }),
});
const cardLinkSegmentDecoder: Decoder<CardLinkSegment> = objectDecoder({
  type: literalDecoder('link'),
  targetCardId: cardIdDecoder,
});
export const bodySegmentDecoder: Decoder<BodySegment> = unionDecoder(
  textSegmentDecoder,
  cardLinkSegmentDecoder,
);
export const bodyDecoder: Decoder<BodySegment[]> = arrayDecoder(
  bodySegmentDecoder,
  {
    maxLength: CONTRACT_LIMITS.bodySegments,
  },
);

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
  title: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  body: bodyDecoder,
  createdAt: nonNegativeSafeIntegerDecoder,
  updatedAt: nonNegativeSafeIntegerDecoder,
} as const;

const upsertMutationDecoder = objectDecoder({
  ...mutationBase,
  kind: literalDecoder('upsert'),
  baseServerRevision: nullableDecoder(positiveSafeIntegerDecoder),
  conflictIds: emptyConflictIdsDecoder,
});
const resolveMutationDecoder = objectDecoder({
  ...mutationBase,
  kind: literalDecoder('resolve'),
  baseServerRevision: positiveSafeIntegerDecoder,
  conflictIds: nonEmptyConflictIdsDecoder,
});
export const pendingMutationDecoder: Decoder<PendingMutation> = refineDecoder(
  unionDecoder(upsertMutationDecoder, resolveMutationDecoder),
  (mutation) => mutation.createdAt <= mutation.updatedAt,
  'expected createdAt <= updatedAt',
);

export type DisplayId = InferDecoder<typeof displayIdDecoder>;
export type CardRecord = InferDecoder<typeof cardRecordDecoder>;
export type ConflictRecord = InferDecoder<typeof conflictRecordDecoder>;

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
