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
  evaluateEncryptedObjectMetadataPurge,
  evaluateVaultPrivateObjectDeletionBarrier,
  evaluateVaultPrivateObjectPurge,
  parseEncryptedWriteId,
  parseOpaqueObjectKey,
  planDeleteAttempt,
  planEncryptedObjectWrite,
  planOrphanCollection,
  planPendingWriteResume,
  planStoredCiphertext,
  planVaultPrivateObjectPurgeAttempt,
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

  it('confirms metadata purge only after every source row has an outbox-backed delete', () => {
    expect(
      evaluateEncryptedObjectMetadataPurge({
        routePresent: true,
        sourceRowsBefore: 3,
        sourceRowsAfter: 0,
      }),
    ).toEqual({ kind: 'confirmed', outcome: 'purged' });
    expect(
      evaluateEncryptedObjectMetadataPurge({
        routePresent: true,
        sourceRowsBefore: 0,
        sourceRowsAfter: 0,
      }),
    ).toEqual({ kind: 'confirmed', outcome: 'already-empty' });
    expect(
      evaluateEncryptedObjectMetadataPurge({
        routePresent: false,
        sourceRowsBefore: 0,
        sourceRowsAfter: 0,
      }),
    ).toEqual({ kind: 'route-not-found' });
    for (const input of [
      { routePresent: true, sourceRowsBefore: 3, sourceRowsAfter: 1 },
      { routePresent: true, sourceRowsBefore: -1, sourceRowsAfter: 0 },
      {
        routePresent: true,
        sourceRowsBefore: 0,
        sourceRowsAfter: Number.NaN,
      },
    ]) {
      expect(evaluateEncryptedObjectMetadataPurge(input)).toEqual({
        kind: 'retryable-failure',
        reason: 'incomplete-inventory',
      });
    }
  });

  it('plans bounded Vault deletion and confirms only an empty durable outbox', () => {
    expect(
      planVaultPrivateObjectPurgeAttempt({
        scopeMatches: true,
        attemptedAt: 10_000,
        retryDelayMs: 5_000,
        batchLimit: 100,
      }),
    ).toEqual({
      kind: 'accepted',
      attemptedAt: 10_000,
      retryDelayMs: 5_000,
      batchLimit: 100,
    });
    for (const input of [
      { attemptedAt: -1, retryDelayMs: 5_000, batchLimit: 100 },
      { attemptedAt: 10_000, retryDelayMs: -1, batchLimit: 100 },
      { attemptedAt: 10_000, retryDelayMs: 5_000, batchLimit: 0 },
      { attemptedAt: 10_000, retryDelayMs: 5_000, batchLimit: 101 },
    ]) {
      expect(
        planVaultPrivateObjectPurgeAttempt({ ...input, scopeMatches: true }),
      ).toEqual({
        kind: 'rejected',
        reason: 'invalid-command',
      });
    }
    expect(
      planVaultPrivateObjectPurgeAttempt({
        scopeMatches: false,
        attemptedAt: 10_000,
        retryDelayMs: 5_000,
        batchLimit: 100,
      }),
    ).toEqual({ kind: 'rejected', reason: 'scope-mismatch' });

    expect(
      evaluateVaultPrivateObjectPurge({
        pendingBefore: 0,
        selected: 0,
        confirmed: 0,
        storageFailures: 0,
        pendingAfter: 0,
      }),
    ).toEqual({ kind: 'confirmed', outcome: 'already-empty' });
    expect(
      evaluateVaultPrivateObjectPurge({
        pendingBefore: 2,
        selected: 2,
        confirmed: 2,
        storageFailures: 0,
        pendingAfter: 0,
      }),
    ).toEqual({ kind: 'confirmed', outcome: 'deleted' });
    expect(
      evaluateVaultPrivateObjectPurge({
        pendingBefore: 2,
        selected: 1,
        confirmed: 1,
        storageFailures: 0,
        pendingAfter: 1,
      }),
    ).toEqual({ kind: 'retryable-failure', reason: 'objects-remaining' });
    expect(
      evaluateVaultPrivateObjectPurge({
        pendingBefore: 2,
        selected: 2,
        confirmed: 1,
        storageFailures: 1,
        pendingAfter: 1,
      }),
    ).toEqual({ kind: 'retryable-failure', reason: 'storage-unavailable' });
    for (const input of [
      {
        pendingBefore: 1,
        selected: 2,
        confirmed: 2,
        storageFailures: 0,
        pendingAfter: 0,
      },
      {
        pendingBefore: 1,
        selected: 1,
        confirmed: 1,
        storageFailures: 0,
        pendingAfter: 2,
      },
    ]) {
      expect(evaluateVaultPrivateObjectPurge(input)).toEqual({
        kind: 'retryable-failure',
        reason: 'delete-confirmation-unavailable',
      });
    }
  });

  it('reconfirms an empty object outbox before irreversible Account finalization', () => {
    expect(
      evaluateVaultPrivateObjectDeletionBarrier({
        ownerCount: 1,
        accountCount: 1,
        vaultCount: 1,
        pendingObjectCount: 0,
      }),
    ).toEqual({ kind: 'confirmed', outcome: 'empty' });
    expect(
      evaluateVaultPrivateObjectDeletionBarrier({
        ownerCount: 1,
        accountCount: 1,
        vaultCount: 1,
        pendingObjectCount: 1,
      }),
    ).toEqual({ kind: 'retryable-failure', reason: 'objects-remaining' });
    expect(
      evaluateVaultPrivateObjectDeletionBarrier({
        ownerCount: 0,
        accountCount: 0,
        vaultCount: 0,
        pendingObjectCount: 0,
      }),
    ).toEqual({ kind: 'confirmed', outcome: 'already-finalized' });
    expect(
      evaluateVaultPrivateObjectDeletionBarrier({
        ownerCount: 0,
        accountCount: 1,
        vaultCount: 1,
        pendingObjectCount: 0,
      }),
    ).toEqual({ kind: 'terminal-failure', reason: 'owner-mismatch' });
    expect(
      evaluateVaultPrivateObjectDeletionBarrier({
        ownerCount: 2,
        accountCount: 1,
        vaultCount: 1,
        pendingObjectCount: 0,
      }),
    ).toEqual({ kind: 'retryable-failure', reason: 'invalid-result' });
  });
});
