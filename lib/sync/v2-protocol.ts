import {
  arrayDecoder,
  BoundaryDecodeError,
  decodeOrThrow,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type DecodeIssue,
  type Decoder,
  type InferDecoder,
} from '../codec/core';
import {
  conflictRecordDecoder,
  CONTRACT_LIMITS,
  pendingMutationDecoder,
  type BodySegment,
  type ConflictRecord,
  type PendingMutation,
} from '../domain/types';
import {
  cardIdDecoder,
  conflictIdDecoder,
  deviceIdDecoder,
  mutationIdDecoder,
  type DeviceId,
} from '../domain/id';
import { assertNever } from '../shared/invariant';
import { serverCardDecoder, type ServerCard } from './protocol';

export const SYNC_V2_VERSION = 'sync/v2' as const;

export const SYNC_V2_LIMITS = {
  cursorCharacters: 2_048,
  mutationsPerRequest: CONTRACT_LIMITS.mutations,
  changesPerPage: 500,
  receiptsPerPage: CONTRACT_LIMITS.mutations,
} as const;

declare const syncV2CursorBrand: unique symbol;
declare const syncSequenceBrand: unique symbol;

export type SyncV2Cursor = string & {
  readonly [syncV2CursorBrand]: 'SyncV2Cursor';
};

export type SyncSequence = number & {
  readonly [syncSequenceBrand]: 'SyncSequence';
};

export const syncV2CursorDecoder: Decoder<SyncV2Cursor> = transformDecoder(
  refineDecoder(
    stringDecoder({
      minLength: 24,
      maxLength: SYNC_V2_LIMITS.cursorCharacters,
    }),
    (value) => /^[A-Za-z0-9._~-]+$/.test(value),
    'expected an opaque URL-safe cursor token',
  ),
  // The lexical proof prevents structured request data from masquerading as a token.
  // Cryptographic authentication belongs to SyncV2CursorAuthenticator.
  (value) => value as SyncV2Cursor,
);

export const syncSequenceDecoder: Decoder<SyncSequence> = transformDecoder(
  safeIntegerDecoder({ minimum: 0 }),
  (value) => value as SyncSequence,
);

const positiveSyncSequenceDecoder: Decoder<SyncSequence> = transformDecoder(
  safeIntegerDecoder({ minimum: 1 }),
  (value) => value as SyncSequence,
);

const cardTombstoneDecoder = objectDecoder({
  kind: literalDecoder('card-tombstone'),
  sequence: positiveSyncSequenceDecoder,
  cardId: cardIdDecoder,
  revision: safeIntegerDecoder({ minimum: 1 }),
  deletedAt: safeIntegerDecoder({ minimum: 0 }),
});

const cardUpsertDecoder = objectDecoder({
  kind: literalDecoder('card-upsert'),
  sequence: positiveSyncSequenceDecoder,
  card: serverCardDecoder,
});

const conflictUpsertDecoder = objectDecoder({
  kind: literalDecoder('conflict-upsert'),
  sequence: positiveSyncSequenceDecoder,
  conflict: conflictRecordDecoder,
});

const conflictTombstoneDecoder = objectDecoder({
  kind: literalDecoder('conflict-tombstone'),
  sequence: positiveSyncSequenceDecoder,
  conflictId: conflictIdDecoder,
  cardId: cardIdDecoder,
  deletedAt: safeIntegerDecoder({ minimum: 0 }),
});

export const syncV2ChangeDecoder = unionDecoder(
  cardUpsertDecoder,
  cardTombstoneDecoder,
  conflictUpsertDecoder,
  conflictTombstoneDecoder,
);

export const syncV2MutationReceiptDecoder = objectDecoder({
  mutationId: mutationIdDecoder,
  cardId: cardIdDecoder,
  appliedRevision: safeIntegerDecoder({ minimum: 1 }),
});

const morePageDecoder = objectDecoder({
  kind: literalDecoder('more'),
  nextCursor: syncV2CursorDecoder,
});

const completePageDecoder = objectDecoder({
  kind: literalDecoder('complete'),
  nextCursor: syncV2CursorDecoder,
});

export const syncV2PageDecoder = unionDecoder(
  morePageDecoder,
  completePageDecoder,
);

export const syncV2RequestDecoder = objectDecoder({
  version: literalDecoder(SYNC_V2_VERSION),
  deviceId: deviceIdDecoder,
  cursor: nullableDecoder(syncV2CursorDecoder),
  mutations: arrayDecoder(pendingMutationDecoder, {
    maxLength: SYNC_V2_LIMITS.mutationsPerRequest,
    uniqueBy: (mutation) => mutation.mutationId,
  }),
});

const syncV2ResponseShapeDecoder = objectDecoder({
  version: literalDecoder(SYNC_V2_VERSION),
  highWatermark: syncSequenceDecoder,
  changes: arrayDecoder(syncV2ChangeDecoder, {
    maxLength: SYNC_V2_LIMITS.changesPerPage,
    uniqueBy: (change) => change.sequence,
  }),
  receipts: arrayDecoder(syncV2MutationReceiptDecoder, {
    maxLength: SYNC_V2_LIMITS.receiptsPerPage,
    uniqueBy: (receipt) => receipt.mutationId,
  }),
  page: syncV2PageDecoder,
});

export type SyncV2Request = {
  version: typeof SYNC_V2_VERSION;
  deviceId: DeviceId;
  cursor: SyncV2Cursor | null;
  mutations: PendingMutation[];
};
export type SyncV2Change = InferDecoder<typeof syncV2ChangeDecoder>;
export type SyncV2MutationReceipt = InferDecoder<
  typeof syncV2MutationReceiptDecoder
>;
export type SyncV2Page = InferDecoder<typeof syncV2PageDecoder>;
export type SyncV2Response = InferDecoder<typeof syncV2ResponseShapeDecoder>;

function responseInvariantIssues(
  response: SyncV2Response,
  sentMutations: readonly PendingMutation[],
): DecodeIssue[] {
  const issues: DecodeIssue[] = [];
  let previousSequence: SyncSequence | undefined;
  for (const [index, change] of response.changes.entries()) {
    if (previousSequence !== undefined && change.sequence <= previousSequence) {
      issues.push({
        path: ['changes', index, 'sequence'],
        reason: 'expected a strictly increasing change sequence',
      });
    }
    if (change.sequence > response.highWatermark) {
      issues.push({
        path: ['changes', index, 'sequence'],
        reason: 'exceeds the response high watermark',
      });
    }
    previousSequence = change.sequence;
  }

  const sentById = new Map(
    sentMutations.map((mutation) => [mutation.mutationId, mutation]),
  );
  for (const [index, receipt] of response.receipts.entries()) {
    const sent = sentById.get(receipt.mutationId);
    if (sent === undefined) {
      issues.push({
        path: ['receipts', index, 'mutationId'],
        reason: 'references a mutation that was not sent',
      });
      continue;
    }
    if (sent.cardId !== receipt.cardId) {
      issues.push({
        path: ['receipts', index, 'cardId'],
        reason: 'does not match the sent mutation card',
      });
    }
  }
  return issues;
}

export function parseSyncV2Cursor(input: unknown): SyncV2Cursor {
  return decodeOrThrow(syncV2CursorDecoder, input, 'SyncV2Cursor');
}

export function parseSyncSequence(input: unknown): SyncSequence {
  return decodeOrThrow(syncSequenceDecoder, input, 'SyncSequence');
}

export function decodeSyncV2Request(input: unknown): SyncV2Request {
  return decodeOrThrow(syncV2RequestDecoder, input, 'SyncV2Request');
}

export function decodeSyncV2Response(
  input: unknown,
  sentMutations: readonly PendingMutation[],
): SyncV2Response {
  const response = decodeOrThrow(
    syncV2ResponseShapeDecoder,
    input,
    'SyncV2Response',
  );
  const issues = responseInvariantIssues(response, sentMutations);
  if (issues.length > 0) {
    throw new BoundaryDecodeError('SyncV2Response invariants', issues);
  }
  return response;
}

function wireString(value: string): string {
  return value;
}

function encodeBody(body: readonly BodySegment[]) {
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
        return assertNever(segment, 'Unsupported v2 body segment');
    }
  });
}

function encodeMutation(mutation: PendingMutation) {
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
      return assertNever(mutation, 'Unsupported v2 mutation');
  }
}

function encodeServerCard(card: ServerCard) {
  return {
    id: wireString(card.id),
    officialDisplayId: card.officialDisplayId,
    title: card.title,
    body: encodeBody(card.body),
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    revision: card.revision,
  };
}

function encodeConflict(conflict: ConflictRecord) {
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

function encodeChange(change: SyncV2Change) {
  switch (change.kind) {
    case 'card-upsert':
      return {
        kind: change.kind,
        sequence: change.sequence,
        card: encodeServerCard(change.card),
      };
    case 'card-tombstone':
      return {
        kind: change.kind,
        sequence: change.sequence,
        cardId: wireString(change.cardId),
        revision: change.revision,
        deletedAt: change.deletedAt,
      };
    case 'conflict-upsert':
      return {
        kind: change.kind,
        sequence: change.sequence,
        conflict: encodeConflict(change.conflict),
      };
    case 'conflict-tombstone':
      return {
        kind: change.kind,
        sequence: change.sequence,
        conflictId: wireString(change.conflictId),
        cardId: wireString(change.cardId),
        deletedAt: change.deletedAt,
      };
    default:
      return assertNever(change, 'Unsupported v2 change');
  }
}

export function encodeSyncV2Request(request: {
  readonly deviceId: DeviceId;
  readonly cursor: SyncV2Cursor | null;
  readonly mutations: readonly PendingMutation[];
}) {
  return {
    version: SYNC_V2_VERSION,
    deviceId: wireString(request.deviceId),
    cursor: request.cursor === null ? null : wireString(request.cursor),
    mutations: request.mutations.map(encodeMutation),
  };
}

export function encodeSyncV2Response(response: SyncV2Response) {
  return {
    version: SYNC_V2_VERSION,
    highWatermark: response.highWatermark,
    changes: response.changes.map(encodeChange),
    receipts: response.receipts.map((receipt) => ({
      mutationId: wireString(receipt.mutationId),
      cardId: wireString(receipt.cardId),
      appliedRevision: receipt.appliedRevision,
    })),
    page: {
      kind: response.page.kind,
      nextCursor: wireString(response.page.nextCursor),
    },
  };
}

export type SyncV2RequestWire = ReturnType<typeof encodeSyncV2Request>;
