import { describe, expect, it } from 'vitest';
import { envelopeCryptoIds } from '@/tests/fixtures/envelope-crypto';
import {
  encryptedObjectIds,
  encryptedObjectMetadata,
  pendingEncryptedWrite,
} from '@/tests/fixtures/encrypted-object';
import {
  decodeEnvelopeCiphertext,
  ENVELOPE_ALGORITHM,
  ENVELOPE_CRYPTO_VERSION,
} from '@/server/crypto/core';
import {
  parseEncryptedWriteId,
  parseOpaqueObjectKey,
  planDeleteAttempt,
  planEncryptedObjectWrite,
  planOrphanCollection,
  planPendingWriteResume,
  planStoredCiphertext,
} from '@/server/encrypted-object/core';

describe('encrypted object pure core', () => {
  it('accepts consecutive CAS and replays only the same idempotent target', () => {
    const current = encryptedObjectMetadata();
    const request = {
      object: current.object,
      expectedRevision: envelopeCryptoIds.objectRevision1,
      nextRevision: envelopeCryptoIds.objectRevision2,
      writeId: encryptedObjectIds.writeB,
      plaintextBytes: 16,
      dekVersion: envelopeCryptoIds.dekVersion1,
      createdAt: 2_000,
    } as const;
    expect(
      planEncryptedObjectWrite({
        current,
        existingWrite: undefined,
        request,
      }),
    ).toEqual({ kind: 'accepted' });
    const committed = encryptedObjectMetadata({
      revision: 2,
      write: 'b',
      key: 'b',
    });
    expect(
      planEncryptedObjectWrite({
        current: committed,
        existingWrite: committed,
        request,
      }),
    ).toEqual({ kind: 'replay', metadata: committed });
    expect(
      planEncryptedObjectWrite({
        current: committed,
        existingWrite: committed,
        request: {
          ...request,
          object: { kind: 'card', objectId: envelopeCryptoIds.cardB },
        },
      }),
    ).toEqual({ kind: 'rejected', reason: 'idempotency-key-reuse' });
  });

  it('rejects stale and non-consecutive revisions and mismatched pending retries', () => {
    const current = encryptedObjectMetadata();
    const base = {
      object: current.object,
      expectedRevision: envelopeCryptoIds.objectRevision1,
      nextRevision: envelopeCryptoIds.objectRevision2,
      writeId: encryptedObjectIds.writeB,
      plaintextBytes: 16,
      dekVersion: envelopeCryptoIds.dekVersion1,
      createdAt: 2_000,
    } as const;
    expect(
      planEncryptedObjectWrite({
        current,
        existingWrite: undefined,
        request: {
          ...base,
          expectedRevision: envelopeCryptoIds.objectRevision2,
        },
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale-revision' });
    expect(
      planPendingWriteResume(pendingEncryptedWrite(), {
        ...base,
        expectedRevision: null,
        nextRevision: envelopeCryptoIds.objectRevision1,
        writeId: encryptedObjectIds.writeA,
        plaintextBytes: 17,
      }),
    ).toEqual({ kind: 'rejected', reason: 'idempotency-key-reuse' });
  });

  it('validates stored ciphertext metadata before decryption', () => {
    const metadata = encryptedObjectMetadata();
    const ciphertext = decodeEnvelopeCiphertext({
      format: ENVELOPE_CRYPTO_VERSION,
      algorithm: ENVELOPE_ALGORITHM,
      dekVersion: envelopeCryptoIds.dekVersion1,
      nonce: envelopeCryptoIds.nonceA,
      sealedPayload: 'AAAAAAAAAAAAAAAAAAAAAA',
    });
    expect(
      planStoredCiphertext({
        metadata,
        ciphertext,
        actualCiphertextBytes: 128,
      }),
    ).toEqual({ kind: 'accepted' });
    expect(
      planStoredCiphertext({
        metadata,
        ciphertext,
        actualCiphertextBytes: 127,
      }),
    ).toEqual({ kind: 'rejected', reason: 'ciphertext-size-mismatch' });
    expect(
      planStoredCiphertext({
        metadata,
        ciphertext: {
          ...ciphertext,
          dekVersion: envelopeCryptoIds.dekVersion2,
        },
        actualCiphertextBytes: 128,
      }),
    ).toEqual({ kind: 'rejected', reason: 'dek-version-mismatch' });
  });

  it('collects only old unprotected objects and plans bounded delete retry', () => {
    expect(
      planOrphanCollection({
        stored: [
          { objectKey: encryptedObjectIds.objectKeyA, createdAt: 1_000 },
          { objectKey: encryptedObjectIds.objectKeyB, createdAt: 1_000 },
          { objectKey: encryptedObjectIds.objectKeyC, createdAt: 9_500 },
        ],
        protectedKeys: new Set([encryptedObjectIds.objectKeyA]),
        scanStartedAt: 10_000,
        gracePeriodMs: 1_000,
      }),
    ).toEqual([encryptedObjectIds.objectKeyB]);
    expect(
      planDeleteAttempt({
        entry: {
          objectKey: encryptedObjectIds.objectKeyB,
          attemptCount: 0,
          nextAttemptAt: 10_000,
          createdAt: 1_000,
        },
        succeeded: false,
        attemptedAt: 10_000,
        retryDelayMs: 5_000,
      }),
    ).toEqual({
      kind: 'retry',
      entry: {
        objectKey: encryptedObjectIds.objectKeyB,
        attemptCount: 1,
        nextAttemptAt: 15_000,
        createdAt: 1_000,
      },
    });
  });

  it('decodes only branded UUID write IDs and opaque 256-bit keys', () => {
    expect(parseEncryptedWriteId(encryptedObjectIds.writeA)).toBe(
      encryptedObjectIds.writeA,
    );
    expect(parseOpaqueObjectKey(encryptedObjectIds.objectKeyA)).toBe(
      encryptedObjectIds.objectKeyA,
    );
    expect(() => parseEncryptedWriteId('write-a')).toThrow();
    expect(() => parseOpaqueObjectKey('vault-a/card-a')).toThrow();
  });
});
