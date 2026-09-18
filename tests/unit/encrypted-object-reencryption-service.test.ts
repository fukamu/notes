import { describe, expect, it } from 'vitest';
import {
  ENVELOPE_ALGORITHM,
  ENVELOPE_CRYPTO_VERSION,
  decodeEnvelopeCiphertext,
} from '@/server/crypto/core';
import type { EnvelopeEncryptionService } from '@/server/crypto/envelope-service';
import { createFakePrivateObjectStorage } from '@/server/adapters/fake-private-object-storage';
import type { EncryptedObjectReencryptionRepository } from '@/server/encrypted-object/reencryption-ports';
import { createEncryptedObjectReencryptionService } from '@/server/encrypted-object/reencryption-service';
import { encodeEncryptedObjectCiphertext } from '@/server/encrypted-object/service';
import { envelopeCryptoIds } from '@/tests/fixtures/envelope-crypto';
import {
  encryptedObjectIds,
  encryptedObjectMetadata,
} from '@/tests/fixtures/encrypted-object';
import { vaultContentContext } from '@/tests/fixtures/vault-content';

describe('encrypted object re-encryption service', () => {
  it('does not advance the checkpoint past a metadata CAS conflict', async () => {
    const context = vaultContentContext('a');
    const oldCiphertext = ciphertext(1);
    const oldBytes = encodeEncryptedObjectCiphertext(oldCiphertext);
    const candidate = {
      ...encryptedObjectMetadata(),
      ciphertextBytes: oldBytes.byteLength,
    };
    const objects = createFakePrivateObjectStorage([
      {
        objectKey: candidate.objectKey,
        bytes: oldBytes,
        createdAt: candidate.createdAt,
      },
    ]);
    const repository = {
      async inventory() {
        return inventory({ olderObjects: 1 });
      },
      async listCandidates() {
        return [candidate];
      },
      async commit() {
        return { kind: 'conflict', current: candidate } as const;
      },
    } satisfies EncryptedObjectReencryptionRepository;
    const service = createEncryptedObjectReencryptionService({
      context,
      repository,
      objects,
      objectKeys: {
        async createObjectKey() {
          return encryptedObjectIds.objectKeyB;
        },
      },
      encryption: passthroughEncryption(),
    });

    await expect(
      service.runBatch({
        keyring: promotedKeyring(),
        limit: 1,
        performedAt: 2_000,
      }),
    ).resolves.toEqual({
      kind: 'pending',
      processed: 0,
      checkpoint: {
        targetVersion: envelopeCryptoIds.dekVersion2,
        after: null,
      },
      reason: 'cas-conflict',
    });
    expect(objects.calls()).toMatchObject({ get: 1, put: 1, delete: 0 });
  });

  it('restarts a completed cursor when an older row appeared behind it', async () => {
    const context = vaultContentContext('a');
    const repository = {
      async inventory() {
        return inventory({ olderObjects: 1 });
      },
      async listCandidates() {
        return [];
      },
      async commit() {
        return { kind: 'conflict' } as const;
      },
    } satisfies EncryptedObjectReencryptionRepository;
    const objects = createFakePrivateObjectStorage();
    const service = createEncryptedObjectReencryptionService({
      context,
      repository,
      objects,
      objectKeys: {
        async createObjectKey() {
          throw new Error('must not generate an object key');
        },
      },
      encryption: {
        async encrypt() {
          throw new Error('must not encrypt');
        },
        async decrypt() {
          throw new Error('must not decrypt');
        },
      },
    });
    const prior = encryptedObjectMetadata();

    await expect(
      service.runBatch({
        keyring: promotedKeyring(),
        checkpoint: {
          targetVersion: envelopeCryptoIds.dekVersion2,
          after: {
            object: prior.object,
            objectRevision: prior.objectRevision,
          },
        },
        limit: 10,
        performedAt: 2_000,
      }),
    ).resolves.toEqual({
      kind: 'pending',
      processed: 0,
      checkpoint: {
        targetVersion: envelopeCryptoIds.dekVersion2,
        after: null,
      },
      reason: 'restart-scan',
    });
    expect(objects.calls()).toEqual({ get: 0, put: 0, delete: 0, list: 0 });
  });
});

function inventory(input: { readonly olderObjects: number }) {
  return {
    routePresent: true,
    olderObjects: input.olderObjects,
    targetObjects: 0,
    newerObjects: 0,
    olderWriteIntents: 0,
    newerWriteIntents: 0,
  };
}

function promotedKeyring() {
  const context = vaultContentContext('a');
  return {
    vaultId: context.vaultId,
    writeVersion: envelopeCryptoIds.dekVersion2,
    versions: [],
  };
}

function ciphertext(version: 1 | 2) {
  return decodeEnvelopeCiphertext({
    format: ENVELOPE_CRYPTO_VERSION,
    algorithm: ENVELOPE_ALGORITHM,
    dekVersion:
      version === 1
        ? envelopeCryptoIds.dekVersion1
        : envelopeCryptoIds.dekVersion2,
    nonce: version === 1 ? envelopeCryptoIds.nonceA : envelopeCryptoIds.nonceB,
    sealedPayload: 'A'.repeat(22),
  });
}

function passthroughEncryption(): EnvelopeEncryptionService {
  return {
    async decrypt() {
      return new Uint8Array(16).fill(1);
    },
    async encrypt() {
      return ciphertext(2);
    },
  };
}
