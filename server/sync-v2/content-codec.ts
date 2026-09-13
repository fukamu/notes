import {
  decodeOrThrow,
  objectDecoder,
  refineDecoder,
  stringDecoder,
} from '../../lib/codec/core';
import {
  bodyDecoder,
  CONTRACT_LIMITS,
  nonNegativeSafeIntegerDecoder,
} from '../../lib/domain/types';
import type { SyncV2StoredCard, SyncV2StoredConflict } from './public';

const storedCardDecoder = refineDecoder(
  objectDecoder({
    title: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
    body: bodyDecoder,
    createdAt: nonNegativeSafeIntegerDecoder,
    updatedAt: nonNegativeSafeIntegerDecoder,
  }),
  (card) => card.createdAt <= card.updatedAt,
  'expected createdAt <= updatedAt',
);

const storedConflictDecoder = objectDecoder({
  localTitle: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  localBody: bodyDecoder,
  serverTitle: stringDecoder({ maxLength: CONTRACT_LIMITS.title }),
  serverBody: bodyDecoder,
  createdAt: nonNegativeSafeIntegerDecoder,
});

export function encodeSyncV2StoredCard(content: SyncV2StoredCard): Uint8Array {
  return encodeJson(content);
}

export function encodeSyncV2StoredConflict(
  content: SyncV2StoredConflict,
): Uint8Array {
  return encodeJson(content);
}

export function decodeSyncV2StoredCard(bytes: Uint8Array): SyncV2StoredCard {
  return decodeOrThrow(storedCardDecoder, decodeJson(bytes), 'Sync v2 card');
}

export function decodeSyncV2StoredConflict(
  bytes: Uint8Array,
): SyncV2StoredConflict {
  return decodeOrThrow(
    storedConflictDecoder,
    decodeJson(bytes),
    'Sync v2 conflict',
  );
}

function encodeJson(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function decodeJson(bytes: Uint8Array): unknown {
  const source = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: false,
  }).decode(bytes);
  const candidate: unknown = JSON.parse(source);
  return candidate;
}
