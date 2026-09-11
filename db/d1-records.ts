import {
  arrayDecoder,
  BoundaryDecodeError,
  decodeOrThrow,
  objectDecoder,
  stringDecoder,
  type Decoder,
  type InferDecoder,
} from '@/lib/codec/core';
import {
  bodyDecoder,
  conflictRecordDecoder,
  CONTRACT_LIMITS,
  nonNegativeSafeIntegerDecoder,
  positiveSafeIntegerDecoder,
} from '@/lib/domain/types';
import {
  cardIdDecoder,
  conflictIdDecoder,
  mutationIdDecoder,
} from '@/lib/domain/id';
import { serverCardDecoder, type ServerCard } from '@/lib/sync/protocol';

const databaseStringDecoder = stringDecoder({
  maxLength: CONTRACT_LIMITS.serializedBody,
});

export const cardRowDecoder = objectDecoder({
  id: cardIdDecoder,
  display_id: positiveSafeIntegerDecoder,
  title: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  body_json: databaseStringDecoder,
  revision: positiveSafeIntegerDecoder,
  created_at: nonNegativeSafeIntegerDecoder,
  updated_at: nonNegativeSafeIntegerDecoder,
  last_mutation_id: mutationIdDecoder,
});

export const conflictRowDecoder = objectDecoder({
  id: conflictIdDecoder,
  card_id: cardIdDecoder,
  server_revision: positiveSafeIntegerDecoder,
  local_title: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  local_body_json: databaseStringDecoder,
  server_title: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  server_body_json: databaseStringDecoder,
  created_at: nonNegativeSafeIntegerDecoder,
});

const mutationMarkerRowDecoder = objectDecoder({ id: mutationIdDecoder });

export type CardRow = InferDecoder<typeof cardRowDecoder>;
export type ConflictRow = InferDecoder<typeof conflictRowDecoder>;

function decodeBodyJson(value: string, path: string) {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new BoundaryDecodeError('D1 body JSON', [
      { path: [path], reason: 'invalid JSON' },
    ]);
  }
  const result = bodyDecoder.decode(parsed, [path]);
  if (!result.ok) throw new BoundaryDecodeError('D1 body JSON', result.issues);
  return result.value;
}

export function decodeCardRow(input: unknown): CardRow {
  return decodeOrThrow(cardRowDecoder, input, 'D1 card row');
}

export function mapCardRow(input: unknown): ServerCard {
  const row = decodeCardRow(input);
  return decodeOrThrow(
    serverCardDecoder,
    {
      id: row.id,
      officialDisplayId: row.display_id,
      title: row.title,
      body: decodeBodyJson(row.body_json, 'body_json'),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      revision: row.revision,
    },
    'D1 card mapping',
  );
}

export function mapConflictRow(input: unknown) {
  const row = decodeOrThrow(conflictRowDecoder, input, 'D1 conflict row');
  return decodeOrThrow(
    conflictRecordDecoder,
    {
      id: row.id,
      cardId: row.card_id,
      serverRevision: row.server_revision,
      localTitle: row.local_title,
      localBody: decodeBodyJson(row.local_body_json, 'local_body_json'),
      serverTitle: row.server_title,
      serverBody: decodeBodyJson(row.server_body_json, 'server_body_json'),
      createdAt: row.created_at,
    },
    'D1 conflict mapping',
  );
}

export function decodeMutationMarker(input: unknown) {
  if (input === null) return null;
  return decodeOrThrow(mutationMarkerRowDecoder, input, 'D1 mutation row');
}

export function decodeD1Results<TValue>(
  input: unknown,
  decoder: Decoder<TValue>,
  maximum: number,
  context: string,
): TValue[] {
  const wrapper = objectDecoder(
    { results: arrayDecoder(decoder, { maxLength: maximum }) },
    { unknownFields: 'allow' },
  );
  return decodeOrThrow(wrapper, input, context).results;
}
