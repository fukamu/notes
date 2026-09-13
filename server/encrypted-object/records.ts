import {
  arrayDecoder,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  safeIntegerDecoder,
  stringDecoder,
  unionDecoder,
  type InferDecoder,
} from '../../lib/codec/core';
import { parseCardId, parseConflictId } from '../../lib/domain/id';
import {
  ENVELOPE_CRYPTO_VERSION,
  cryptoObjectRevisionDecoder,
  dekVersionDecoder,
  type EnvelopeObject,
} from '../crypto/core';
import {
  encryptedWriteIdDecoder,
  opaqueObjectKeyDecoder,
  storedByteCountDecoder,
  type DeleteOutboxEntry,
  type EncryptedObjectMetadata,
  type PendingEncryptedWrite,
} from './core';

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const attemptCountDecoder = safeIntegerDecoder({
  minimum: 0,
  maximum: 2_147_483_647,
});
const storedIdentifierDecoder = stringDecoder({ minLength: 36, maxLength: 36 });
const objectTypeDecoder = unionDecoder(
  literalDecoder('card'),
  literalDecoder('conflict'),
);

export const encryptedObjectMetadataRowDecoder = objectDecoder({
  object_type: objectTypeDecoder,
  object_id: storedIdentifierDecoder,
  object_revision: cryptoObjectRevisionDecoder,
  write_id: encryptedWriteIdDecoder,
  object_key: opaqueObjectKeyDecoder,
  plaintext_bytes: storedByteCountDecoder,
  ciphertext_bytes: storedByteCountDecoder,
  crypto_version: literalDecoder(ENVELOPE_CRYPTO_VERSION),
  dek_version: dekVersionDecoder,
  created_at: timestampDecoder,
});

export const pendingEncryptedWriteRowDecoder = objectDecoder({
  object_type: objectTypeDecoder,
  object_id: storedIdentifierDecoder,
  expected_revision: nullableDecoder(cryptoObjectRevisionDecoder),
  object_revision: cryptoObjectRevisionDecoder,
  write_id: encryptedWriteIdDecoder,
  object_key: opaqueObjectKeyDecoder,
  plaintext_bytes: storedByteCountDecoder,
  crypto_version: literalDecoder(ENVELOPE_CRYPTO_VERSION),
  dek_version: dekVersionDecoder,
  created_at: timestampDecoder,
});

export const deleteOutboxRowDecoder = objectDecoder({
  object_key: opaqueObjectKeyDecoder,
  attempt_count: attemptCountDecoder,
  next_attempt_at: timestampDecoder,
  created_at: timestampDecoder,
});

export const protectedObjectKeyRowsDecoder = arrayDecoder(
  objectDecoder({ object_key: opaqueObjectKeyDecoder }),
  { maxLength: 30_000, uniqueBy: (row) => row.object_key },
);

export const deleteOutboxRowsDecoder = arrayDecoder(deleteOutboxRowDecoder, {
  maxLength: 100,
  uniqueBy: (row) => row.object_key,
});

export type EncryptedObjectMetadataRow = InferDecoder<
  typeof encryptedObjectMetadataRowDecoder
>;
export type PendingEncryptedWriteRow = InferDecoder<
  typeof pendingEncryptedWriteRowDecoder
>;
export type DeleteOutboxRow = InferDecoder<typeof deleteOutboxRowDecoder>;

export function mapEncryptedObjectMetadataRow(
  row: EncryptedObjectMetadataRow,
): EncryptedObjectMetadata {
  return {
    object: mapEnvelopeObject(row.object_type, row.object_id),
    objectRevision: row.object_revision,
    writeId: row.write_id,
    objectKey: row.object_key,
    plaintextBytes: row.plaintext_bytes,
    ciphertextBytes: row.ciphertext_bytes,
    cryptoVersion: row.crypto_version,
    dekVersion: row.dek_version,
    createdAt: row.created_at,
  };
}

export function mapPendingEncryptedWriteRow(
  row: PendingEncryptedWriteRow,
): PendingEncryptedWrite {
  return {
    object: mapEnvelopeObject(row.object_type, row.object_id),
    expectedRevision: row.expected_revision,
    objectRevision: row.object_revision,
    writeId: row.write_id,
    objectKey: row.object_key,
    plaintextBytes: row.plaintext_bytes,
    cryptoVersion: row.crypto_version,
    dekVersion: row.dek_version,
    createdAt: row.created_at,
  };
}

export function mapDeleteOutboxRow(row: DeleteOutboxRow): DeleteOutboxEntry {
  return {
    objectKey: row.object_key,
    attemptCount: row.attempt_count,
    nextAttemptAt: row.next_attempt_at,
    createdAt: row.created_at,
  };
}

function mapEnvelopeObject(
  objectType: 'card' | 'conflict',
  objectId: string,
): EnvelopeObject {
  switch (objectType) {
    case 'card':
      return { kind: 'card', objectId: parseCardId(objectId) };
    case 'conflict':
      return {
        kind: 'conflict',
        objectId: parseConflictId(objectId),
      };
  }
}
