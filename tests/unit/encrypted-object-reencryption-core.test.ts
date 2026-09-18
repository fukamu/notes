import { describe, expect, it } from 'vitest';
import { parseDekVersion } from '@/server/crypto/core';
import {
  evaluateEncryptedObjectReencryptionInventory,
  planEncryptedObjectReencryptionCandidate,
  planEncryptedObjectReencryptionRequest,
  sameEncryptedObjectMetadata,
} from '@/server/encrypted-object/reencryption-core';
import { envelopeCryptoIds } from '@/tests/fixtures/envelope-crypto';
import {
  encryptedObjectIds,
  encryptedObjectMetadata,
} from '@/tests/fixtures/encrypted-object';
import { vaultContentContext } from '@/tests/fixtures/vault-content';

describe('encrypted object re-encryption core', () => {
  it('binds a bounded checkpoint to the promoted write version', () => {
    const context = vaultContentContext('a');
    const keyring = {
      vaultId: context.vaultId,
      writeVersion: envelopeCryptoIds.dekVersion2,
      versions: [],
    };
    const initial = planEncryptedObjectReencryptionRequest({
      vaultId: context.vaultId,
      keyring,
      limit: 100,
      performedAt: 1_000,
    });
    expect(initial).toEqual({
      kind: 'accepted',
      targetVersion: envelopeCryptoIds.dekVersion2,
      checkpoint: {
        targetVersion: envelopeCryptoIds.dekVersion2,
        after: null,
      },
      limit: 100,
    });
    expect(
      planEncryptedObjectReencryptionRequest({
        vaultId: context.vaultId,
        keyring,
        checkpoint: {
          targetVersion: envelopeCryptoIds.dekVersion1,
          after: null,
        },
        limit: 10,
        performedAt: 1_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'checkpoint-target-mismatch' });
    expect(
      planEncryptedObjectReencryptionRequest({
        vaultId: context.vaultId,
        keyring,
        limit: 101,
        performedAt: 1_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-limit' });
    expect(
      planEncryptedObjectReencryptionRequest({
        vaultId: vaultContentContext('b').vaultId,
        keyring,
        limit: 1,
        performedAt: 1_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'vault-mismatch' });
    expect(
      planEncryptedObjectReencryptionRequest({
        vaultId: context.vaultId,
        keyring,
        limit: 1,
        performedAt: -1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-timestamp' });
  });

  it('distinguishes completed, stale-route and impossible newer-version inventories', () => {
    expect(
      evaluateEncryptedObjectReencryptionInventory({
        routePresent: true,
        olderObjects: 0,
        targetObjects: 4,
        newerObjects: 0,
        olderWriteIntents: 0,
        newerWriteIntents: 0,
      }),
    ).toEqual({ kind: 'completed' });
    expect(
      evaluateEncryptedObjectReencryptionInventory({
        routePresent: true,
        olderObjects: 1,
        targetObjects: 4,
        newerObjects: 0,
        olderWriteIntents: 0,
        newerWriteIntents: 0,
      }),
    ).toEqual({ kind: 'scan' });
    expect(
      evaluateEncryptedObjectReencryptionInventory({
        routePresent: false,
        olderObjects: 0,
        targetObjects: 0,
        newerObjects: 0,
        olderWriteIntents: 0,
        newerWriteIntents: 0,
      }),
    ).toEqual({ kind: 'rejected', reason: 'route-not-found' });
    expect(
      evaluateEncryptedObjectReencryptionInventory({
        routePresent: true,
        olderObjects: 0,
        targetObjects: 0,
        newerObjects: 1,
        olderWriteIntents: 0,
        newerWriteIntents: 0,
      }),
    ).toEqual({ kind: 'rejected', reason: 'newer-version' });
    expect(
      evaluateEncryptedObjectReencryptionInventory({
        routePresent: true,
        olderObjects: 0,
        targetObjects: 4,
        newerObjects: 0,
        olderWriteIntents: 1,
        newerWriteIntents: 0,
      }),
    ).toEqual({ kind: 'wait-for-pending-writes' });
  });

  it('changes only physical ciphertext metadata and rejects unsafe replacements', () => {
    const candidate = encryptedObjectMetadata();
    const accepted = planEncryptedObjectReencryptionCandidate({
      candidate,
      targetVersion: envelopeCryptoIds.dekVersion2,
      replacementObjectKey: encryptedObjectIds.objectKeyB,
      replacementCiphertextBytes: 192,
    });
    expect(accepted).toEqual({
      kind: 'accepted',
      replacement: {
        ...candidate,
        objectKey: encryptedObjectIds.objectKeyB,
        ciphertextBytes: 192,
        dekVersion: envelopeCryptoIds.dekVersion2,
      },
    });
    expect(
      accepted.kind === 'accepted' &&
        sameEncryptedObjectMetadata(accepted.replacement, {
          ...candidate,
          objectKey: encryptedObjectIds.objectKeyB,
          ciphertextBytes: 192,
          dekVersion: envelopeCryptoIds.dekVersion2,
        }),
    ).toBe(true);
    expect(
      planEncryptedObjectReencryptionCandidate({
        candidate,
        targetVersion: candidate.dekVersion,
        replacementObjectKey: encryptedObjectIds.objectKeyB,
        replacementCiphertextBytes: 192,
      }),
    ).toEqual({ kind: 'rejected', reason: 'candidate-not-older' });
    expect(
      planEncryptedObjectReencryptionCandidate({
        candidate,
        targetVersion: parseDekVersion(2),
        replacementObjectKey: candidate.objectKey,
        replacementCiphertextBytes: 192,
      }),
    ).toEqual({ kind: 'rejected', reason: 'object-key-reuse' });
  });
});
