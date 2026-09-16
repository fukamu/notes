import { describe, expect, it } from 'vitest';
import { createFakeKeyManagement } from '@/server/adapters/fake-key-management';
import {
  createFakeVaultRecoveryBackup,
  FakeVaultRecoveryBackupError,
} from '@/server/adapters/fake-vault-recovery-backup';
import type { VaultDekKeyring } from '@/server/crypto/core';
import {
  createEnvelopeEncryptionService,
  type EnvelopeEncryptionService,
} from '@/server/crypto/envelope-service';
import { webCryptoAes256Gcm } from '@/server/crypto/web-aes-gcm';
import {
  maximumBackupRetentionMs,
  VAULT_RECOVERY_FORMAT,
} from '@/server/encrypted-object/recovery-core';
import { createVaultRecoveryDrillService } from '@/server/encrypted-object/recovery-service';
import { encodeEncryptedObjectCiphertext } from '@/server/encrypted-object/service';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import {
  envelopeCryptoIds,
  envelopeDekMetadata,
  envelopeKeyBytes,
  envelopeKeyring,
} from '@/tests/fixtures/envelope-crypto';
import {
  encryptedObjectIds,
  encryptedObjectMetadata,
} from '@/tests/fixtures/encrypted-object';
import {
  completedRecoveryRotation,
  vaultRecoveryIds,
} from '@/tests/fixtures/vault-recovery';

const scope = {
  accountId: controlPlaneIds.accountA,
  vaultId: controlPlaneIds.vaultA,
};

describe('Vault recovery drill', () => {
  it('authenticates mixed old/new backup ciphertext and returns metadata-only evidence', async () => {
    const fixture = await recoveryFixture();
    const backup = createFakeVaultRecoveryBackup({
      manifest: fixture.manifest,
      objects: fixture.objects,
    });
    const service = createVaultRecoveryDrillService({
      backup,
      encryption: encryptionFor([1, 2]),
    });

    const result = await service.run({ scope, drilledAt: 3_000 });
    expect(result).toEqual({
      kind: 'verified',
      receipt: {
        backupId: vaultRecoveryIds.backupA,
        ...scope,
        operationId: vaultRecoveryIds.operation,
        sourceVersion: envelopeCryptoIds.dekVersion1,
        targetVersion: envelopeCryptoIds.dekVersion2,
        capturedAt: 2_200,
        deleteAfter: 2_200 + maximumBackupRetentionMs,
        drilledAt: 3_000,
        objectCount: 2,
        verifiedVersions: [
          envelopeCryptoIds.dekVersion1,
          envelopeCryptoIds.dekVersion2,
        ],
      },
    });
    expect(backup.calls()).toEqual({ manifest: 1, ciphertext: 2 });
    expect(JSON.stringify(result)).not.toContain('same-size-card');
    expect(JSON.stringify(result)).not.toContain('wrappedDek');
  });

  it('rejects malformed manifests and pending checkpoints before reading ciphertext', async () => {
    const fixture = await recoveryFixture();
    const malformed = createFakeVaultRecoveryBackup({
      manifest: {
        ...fixture.manifest,
        deleteAfter: 2_200 + maximumBackupRetentionMs + 1,
      },
      objects: fixture.objects,
    });
    await expect(
      createVaultRecoveryDrillService({
        backup: malformed,
        encryption: encryptionFor([1, 2]),
      }).run({ scope, drilledAt: 3_000 }),
    ).resolves.toEqual({ kind: 'blocked', reason: 'invalid-manifest' });
    expect(malformed.calls()).toEqual({ manifest: 1, ciphertext: 0 });

    const pending = createFakeVaultRecoveryBackup({
      manifest: {
        ...fixture.manifest,
        reencryption: {
          kind: 'pending',
          checkpoint: {
            targetVersion: envelopeCryptoIds.dekVersion2,
            after: null,
          },
        },
      },
      objects: fixture.objects,
    });
    await expect(
      createVaultRecoveryDrillService({
        backup: pending,
        encryption: encryptionFor([1, 2]),
      }).run({ scope, drilledAt: 3_000 }),
    ).resolves.toEqual({ kind: 'blocked', reason: 'incomplete-checkpoint' });
    expect(pending.calls()).toEqual({ manifest: 1, ciphertext: 0 });
  });

  it('fails closed for a missing old key, missing object, and backup outage', async () => {
    const fixture = await recoveryFixture();
    const complete = createFakeVaultRecoveryBackup({
      manifest: fixture.manifest,
      objects: fixture.objects,
    });
    await expect(
      createVaultRecoveryDrillService({
        backup: complete,
        encryption: encryptionFor([2]),
      }).run({ scope, drilledAt: 3_000 }),
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'authentication-failed',
    });

    const missing = createFakeVaultRecoveryBackup({
      manifest: fixture.manifest,
      objects: fixture.objects.slice(0, 1),
    });
    await expect(
      createVaultRecoveryDrillService({
        backup: missing,
        encryption: encryptionFor([1, 2]),
      }).run({ scope, drilledAt: 3_000 }),
    ).resolves.toEqual({ kind: 'blocked', reason: 'missing-object' });

    complete.failNext('manifest');
    await expect(
      createVaultRecoveryDrillService({
        backup: complete,
        encryption: encryptionFor([1, 2]),
      }).run({ scope, drilledAt: 3_000 }),
    ).resolves.toEqual({ kind: 'blocked', reason: 'backup-unavailable' });
    complete.failNext('ciphertext');
    await expect(
      createVaultRecoveryDrillService({
        backup: complete,
        encryption: encryptionFor([1, 2]),
      }).run({ scope, drilledAt: 3_000 }),
    ).resolves.toEqual({ kind: 'blocked', reason: 'backup-unavailable' });
    expect(FakeVaultRecoveryBackupError.name).toBe(
      'FakeVaultRecoveryBackupError',
    );
  });

  it('rejects ciphertext swaps and non-byte backup values without a receipt', async () => {
    const fixture = await recoveryFixture();
    const swapped = createFakeVaultRecoveryBackup({
      manifest: fixture.manifest,
      objects: [
        { ...fixture.objects[0], value: fixture.wrongAadCiphertext },
        fixture.objects[1],
      ],
    });
    await expect(
      createVaultRecoveryDrillService({
        backup: swapped,
        encryption: encryptionFor([1, 2]),
      }).run({ scope, drilledAt: 3_000 }),
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'authentication-failed',
    });

    const invalid = createFakeVaultRecoveryBackup({
      manifest: fixture.manifest,
      objects: [
        { ...fixture.objects[0], value: 'not-ciphertext-bytes' },
        fixture.objects[1],
      ],
    });
    await expect(
      createVaultRecoveryDrillService({
        backup: invalid,
        encryption: encryptionFor([1, 2]),
      }).run({ scope, drilledAt: 3_000 }),
    ).resolves.toEqual({ kind: 'blocked', reason: 'invalid-ciphertext' });
  });
});

async function recoveryFixture() {
  const encryption = encryptionFor([1, 2]);
  const plaintextA = new TextEncoder().encode('same-size-card-a');
  const plaintextB = new TextEncoder().encode('same-size-card-b');
  const metadataA = encryptedObjectMetadata();
  const metadataB = {
    ...encryptedObjectMetadata({ card: 'b', write: 'b', key: 'b' }),
    dekVersion: envelopeCryptoIds.dekVersion2,
  };
  const ciphertextA = encodeEncryptedObjectCiphertext(
    await encrypt(encryption, envelopeKeyring(), metadataA, plaintextA),
  );
  const ciphertextB = encodeEncryptedObjectCiphertext(
    await encrypt(encryption, envelopeKeyring(2), metadataB, plaintextB),
  );
  const wrongAadCiphertext = encodeEncryptedObjectCiphertext(
    await encrypt(encryption, envelopeKeyring(), metadataB, plaintextB),
  );
  const manifest = {
    format: VAULT_RECOVERY_FORMAT,
    backupId: vaultRecoveryIds.backupA,
    ...scope,
    capturedAt: 2_200,
    deleteAfter: 2_200 + maximumBackupRetentionMs,
    keyring: envelopeKeyring(2),
    rotation: completedRecoveryRotation(),
    reencryption: {
      kind: 'completed',
      targetVersion: envelopeCryptoIds.dekVersion2,
    },
    objects: [
      { ...metadataA, ciphertextBytes: ciphertextA.byteLength },
      { ...metadataB, ciphertextBytes: ciphertextB.byteLength },
    ],
  };
  return {
    manifest,
    wrongAadCiphertext,
    objects: [
      {
        backupId: vaultRecoveryIds.backupA,
        objectKey: encryptedObjectIds.objectKeyA,
        value: ciphertextA,
      },
      {
        backupId: vaultRecoveryIds.backupA,
        objectKey: encryptedObjectIds.objectKeyB,
        value: ciphertextB,
      },
    ] as const,
  };
}

function encrypt(
  encryption: EnvelopeEncryptionService,
  keyring: VaultDekKeyring,
  metadata: ReturnType<typeof encryptedObjectMetadata>,
  plaintext: Uint8Array,
) {
  return encryption.encrypt({
    keyring,
    context: {
      vaultId: controlPlaneIds.vaultA,
      object: metadata.object,
      objectRevision: metadata.objectRevision,
    },
    plaintext,
  });
}

function encryptionFor(versions: readonly (1 | 2)[]) {
  return createEnvelopeEncryptionService({
    keyManagement: createFakeKeyManagement({
      records: versions.map((version) => ({
        metadata: envelopeDekMetadata(version),
        keyBytes:
          version === 1 ? envelopeKeyBytes.version1 : envelopeKeyBytes.version2,
      })),
    }),
    nonceGenerator: nonceGenerator(),
    nonceReservations: nonceReservations(),
    aesGcm: webCryptoAes256Gcm,
  });
}

function nonceGenerator() {
  let next = 0;
  return {
    async createNonce() {
      const bytes = new Uint8Array(12);
      bytes.fill(next);
      next += 1;
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
    },
  };
}

function nonceReservations() {
  const reserved = new Set<string>();
  return {
    async reserve(input: {
      readonly vaultId: string;
      readonly dekVersion: number;
      readonly nonce: string;
    }) {
      const key = `${input.vaultId}:${input.dekVersion}:${input.nonce}`;
      if (reserved.has(key)) return false;
      reserved.add(key);
      return true;
    },
  };
}
