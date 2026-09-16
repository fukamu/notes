import {
  ENVELOPE_CRYPTO_VERSION,
  parseCryptoObjectRevision,
} from '@/server/crypto/core';
import {
  parseEncryptedWriteId,
  parseOpaqueObjectKey,
  type EncryptedObjectMetadata,
  type PendingEncryptedWrite,
} from '@/server/encrypted-object/core';
import { envelopeCryptoIds } from '@/tests/fixtures/envelope-crypto';
import { fixtureMutationId } from '@/tests/fixtures/ids';

export const encryptedObjectIds = {
  writeA: parseEncryptedWriteId(fixtureMutationId('encrypted-write-a')),
  writeB: parseEncryptedWriteId(fixtureMutationId('encrypted-write-b')),
  writeC: parseEncryptedWriteId(fixtureMutationId('encrypted-write-c')),
  objectKeyA: parseOpaqueObjectKey(`obj_v1_${'A'.repeat(43)}`),
  objectKeyB: parseOpaqueObjectKey(`obj_v1_${'B'.repeat(43)}`),
  objectKeyC: parseOpaqueObjectKey(`obj_v1_${'C'.repeat(43)}`),
  objectKeyD: parseOpaqueObjectKey(`obj_v1_${'D'.repeat(43)}`),
  objectKeyE: parseOpaqueObjectKey(`obj_v1_${'E'.repeat(43)}`),
  objectKeyF: parseOpaqueObjectKey(`obj_v1_${'F'.repeat(43)}`),
} as const;

export function pendingEncryptedWrite(
  input: {
    readonly revision?: 1 | 2;
    readonly write?: 'a' | 'b';
    readonly key?: 'a' | 'b';
    readonly card?: 'a' | 'b';
  } = {},
): PendingEncryptedWrite {
  const revision = input.revision ?? 1;
  return {
    object: {
      kind: 'card',
      objectId:
        input.card === 'b' ? envelopeCryptoIds.cardB : envelopeCryptoIds.cardA,
    },
    expectedRevision:
      revision === 1 ? null : parseCryptoObjectRevision(revision - 1),
    objectRevision: parseCryptoObjectRevision(revision),
    writeId:
      input.write === 'b'
        ? encryptedObjectIds.writeB
        : encryptedObjectIds.writeA,
    objectKey:
      input.key === 'b'
        ? encryptedObjectIds.objectKeyB
        : encryptedObjectIds.objectKeyA,
    plaintextBytes: 16,
    cryptoVersion: ENVELOPE_CRYPTO_VERSION,
    dekVersion: envelopeCryptoIds.dekVersion1,
    createdAt: revision * 1_000,
  };
}

export function encryptedObjectMetadata(
  input: {
    readonly revision?: 1 | 2;
    readonly write?: 'a' | 'b';
    readonly key?: 'a' | 'b';
    readonly card?: 'a' | 'b';
  } = {},
): EncryptedObjectMetadata {
  const intent = pendingEncryptedWrite(input);
  return {
    object: intent.object,
    objectRevision: intent.objectRevision,
    writeId: intent.writeId,
    objectKey: intent.objectKey,
    plaintextBytes: intent.plaintextBytes,
    ciphertextBytes: 128,
    cryptoVersion: intent.cryptoVersion,
    dekVersion: intent.dekVersion,
    createdAt: intent.createdAt,
  };
}
