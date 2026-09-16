import {
  arrayDecoder,
  BoundaryDecodeError,
  decodeOrThrow,
  objectDecoder,
  refineDecoder,
  stringDecoder,
  type DecodeIssue,
  type InferDecoder,
} from '../codec/core';
import {
  bodyDecoder,
  conflictRecordDecoder,
  CONTRACT_LIMITS,
  pendingMutationDecoder,
  positiveSafeIntegerDecoder,
  nonNegativeSafeIntegerDecoder,
  type BodySegment,
  type PendingMutation,
} from '../domain/types';
import {
  cardIdDecoder,
  deviceIdDecoder,
  mutationIdDecoder,
  type DeviceId,
} from '../domain/id';
import { assertNever } from '../shared/invariant';

export const syncRequestDecoder = objectDecoder({
  deviceId: deviceIdDecoder,
  mutations: arrayDecoder(pendingMutationDecoder, {
    maxLength: CONTRACT_LIMITS.mutations,
    uniqueBy: (mutation) => mutation.mutationId,
  }),
});

export const serverCardDecoder = refineDecoder(
  objectDecoder({
    id: cardIdDecoder,
    officialDisplayId: positiveSafeIntegerDecoder,
    title: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
    body: bodyDecoder,
    createdAt: nonNegativeSafeIntegerDecoder,
    updatedAt: nonNegativeSafeIntegerDecoder,
    revision: positiveSafeIntegerDecoder,
  }),
  (card) => card.createdAt <= card.updatedAt,
  'expected createdAt <= updatedAt',
);

export const syncResponseDecoder = objectDecoder({
  cards: arrayDecoder(serverCardDecoder, {
    maxLength: CONTRACT_LIMITS.cards,
  }),
  conflicts: arrayDecoder(conflictRecordDecoder, {
    maxLength: CONTRACT_LIMITS.conflicts,
  }),
  acknowledgedMutationIds: arrayDecoder(mutationIdDecoder, {
    maxLength: CONTRACT_LIMITS.mutations,
  }),
});

export type SyncRequest = InferDecoder<typeof syncRequestDecoder>;
export type ServerCard = InferDecoder<typeof serverCardDecoder>;
export type SyncResponse = InferDecoder<typeof syncResponseDecoder>;

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
        return assertNever(segment, 'Unsupported body segment');
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
      return assertNever(mutation, 'Unsupported mutation');
  }
}

export function encodeSyncRequest(request: {
  deviceId: DeviceId;
  mutations: PendingMutation[];
}) {
  return {
    deviceId: wireString(request.deviceId),
    mutations: request.mutations.map(encodeMutation),
  };
}

export type SyncRequestWire = ReturnType<typeof encodeSyncRequest>;

function duplicateIssues<TValue>(
  values: TValue[],
  key: (value: TValue) => string | number,
  path: string,
): DecodeIssue[] {
  const seen = new Set<string | number>();
  const issues: DecodeIssue[] = [];
  for (const [index, value] of values.entries()) {
    const identifier = key(value);
    if (seen.has(identifier)) {
      issues.push({
        path: [path, index],
        reason: 'duplicate value',
      });
    }
    seen.add(identifier);
  }
  return issues;
}

export function decodeSyncRequest(input: unknown): SyncRequest {
  return decodeOrThrow(syncRequestDecoder, input, 'SyncRequest');
}

export function decodeSyncResponse(
  input: unknown,
  sentMutations: PendingMutation[],
): SyncResponse {
  const response = decodeOrThrow(syncResponseDecoder, input, 'SyncResponse');
  const issues: DecodeIssue[] = [
    ...duplicateIssues(response.cards, (card) => card.id, 'cards'),
    ...duplicateIssues(
      response.cards,
      (card) => card.officialDisplayId,
      'cards',
    ),
    ...duplicateIssues(
      response.conflicts,
      (conflict) => conflict.id,
      'conflicts',
    ),
    ...duplicateIssues(
      response.acknowledgedMutationIds,
      (mutationId) => mutationId,
      'acknowledgedMutationIds',
    ),
  ];

  const sentIds = new Set(sentMutations.map((mutation) => mutation.mutationId));
  for (const [
    index,
    mutationId,
  ] of response.acknowledgedMutationIds.entries()) {
    if (!sentIds.has(mutationId)) {
      issues.push({
        path: ['acknowledgedMutationIds', index],
        reason: 'acknowledges a mutation that was not sent',
      });
    }
  }

  const cardIds = new Set(response.cards.map((card) => card.id));
  for (const [cardIndex, card] of response.cards.entries()) {
    for (const [segmentIndex, segment] of card.body.entries()) {
      if (segment.type === 'link' && !cardIds.has(segment.targetCardId)) {
        issues.push({
          path: ['cards', cardIndex, 'body', segmentIndex, 'targetCardId'],
          reason: 'references a card absent from the response',
        });
      }
    }
  }
  for (const [index, conflict] of response.conflicts.entries()) {
    if (!cardIds.has(conflict.cardId)) {
      issues.push({
        path: ['conflicts', index, 'cardId'],
        reason: 'references a card absent from the response',
      });
    }
  }

  if (issues.length > 0) {
    throw new BoundaryDecodeError('SyncResponse invariants', issues);
  }
  return response;
}
