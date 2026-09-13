import { describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import {
  envelopeCryptoIds,
  envelopeDekMetadata,
  envelopeKeyBytes,
  envelopeKeyring,
  envelopeObjectContext,
} from '@/tests/fixtures/envelope-crypto';
import {
  FakeKeyManagementError,
  createFakeKeyManagement,
} from '@/server/adapters/fake-key-management';
import {
  EnvelopePolicyError,
  createEnvelopeEncryptionService,
} from '@/server/crypto/envelope-service';
import type {
  KeyManagementPort,
  NonceGeneratorPort,
  NonceReservationPort,
} from '@/server/crypto/ports';
import {
  EnvelopeAuthenticationError,
  webCryptoAes256Gcm,
} from '@/server/crypto/web-aes-gcm';

describe('Envelope encryption service', () => {
  it('round-trips and rejects tamper, object swap, revision swap, and wrong Vault', async () => {
    const nonceState = fakeNonceState([envelopeCryptoIds.nonceA]);
    const service = serviceWith(keyManagement(), nonceState);
    const context = envelopeObjectContext();
    const plaintext = new TextEncoder().encode('private title and body');
    const ciphertext = await service.encrypt({
      keyring: envelopeKeyring(),
      context,
      plaintext,
    });
    await expect(
      service.decrypt({ keyring: envelopeKeyring(), context, ciphertext }),
    ).resolves.toEqual(plaintext);

    const tampered = {
      ...ciphertext,
      sealedPayload: replaceFirstCharacter(ciphertext.sealedPayload),
    };
    await expect(
      service.decrypt({
        keyring: envelopeKeyring(),
        context,
        ciphertext: tampered,
      }),
    ).rejects.toBeInstanceOf(EnvelopeAuthenticationError);
    await expect(
      service.decrypt({
        keyring: envelopeKeyring(),
        context: envelopeObjectContext({ card: 'b' }),
        ciphertext,
      }),
    ).rejects.toBeInstanceOf(EnvelopeAuthenticationError);
    await expect(
      service.decrypt({
        keyring: envelopeKeyring(),
        context: envelopeObjectContext({ revision: 2 }),
        ciphertext,
      }),
    ).rejects.toBeInstanceOf(EnvelopeAuthenticationError);
    await expect(
      service.decrypt({
        keyring: envelopeKeyring(2),
        context,
        ciphertext: {
          ...ciphertext,
          dekVersion: envelopeCryptoIds.dekVersion2,
        },
      }),
    ).rejects.toBeInstanceOf(EnvelopeAuthenticationError);
    await expect(
      service.decrypt({
        keyring: envelopeKeyring(),
        context: {
          ...context,
          object: {
            kind: 'conflict',
            objectId: envelopeCryptoIds.conflict,
          },
        },
        ciphertext,
      }),
    ).rejects.toBeInstanceOf(EnvelopeAuthenticationError);
    await expect(
      service.decrypt({
        keyring: envelopeKeyring(),
        context: envelopeObjectContext({ vaultId: controlPlaneIds.vaultB }),
        ciphertext,
      }),
    ).rejects.toBeInstanceOf(EnvelopePolicyError);
    await expect(
      service.decrypt({
        keyring: envelopeKeyring(),
        context,
        ciphertext: { ...ciphertext, format: 'unsupported' },
      }),
    ).rejects.toBeInstanceOf(BoundaryDecodeError);
  });

  it('retains mixed-version reads and reserves a new nonce after collision', async () => {
    const reserved = new Set<string>();
    const firstNonce = fakeNonceState([envelopeCryptoIds.nonceA], reserved);
    const serviceV1 = serviceWith(keyManagement(), firstNonce);
    const context = envelopeObjectContext();
    const plaintextV1 = new TextEncoder().encode('version one');
    const ciphertextV1 = await serviceV1.encrypt({
      keyring: envelopeKeyring(),
      context,
      plaintext: plaintextV1,
    });

    const secondNonce = fakeNonceState(
      [envelopeCryptoIds.nonceA, envelopeCryptoIds.nonceB],
      reserved,
    );
    const serviceV2 = serviceWith(keyManagement(), secondNonce);
    await expect(
      serviceV2.decrypt({
        keyring: envelopeKeyring(2),
        context,
        ciphertext: ciphertextV1,
      }),
    ).resolves.toEqual(plaintextV1);
    reserved.add(
      `${controlPlaneIds.vaultA}:${envelopeCryptoIds.dekVersion2}:${envelopeCryptoIds.nonceA}`,
    );
    const ciphertextV2 = await serviceV2.encrypt({
      keyring: envelopeKeyring(2),
      context: envelopeObjectContext({ revision: 2 }),
      plaintext: new TextEncoder().encode('version two'),
    });
    expect(ciphertextV2.dekVersion).toBe(envelopeCryptoIds.dekVersion2);
    expect(ciphertextV2.nonce).toBe(envelopeCryptoIds.nonceB);
    await expect(
      serviceV2.decrypt({
        keyring: envelopeKeyring(),
        context: envelopeObjectContext({ revision: 2 }),
        ciphertext: ciphertextV2,
      }),
    ).rejects.toBeInstanceOf(EnvelopePolicyError);
  });

  it('fails closed for KMS failure on both write and read', async () => {
    const context = envelopeObjectContext();
    const workingService = serviceWith(
      keyManagement(),
      fakeNonceState([envelopeCryptoIds.nonceA]),
    );
    const ciphertext = await workingService.encrypt({
      keyring: envelopeKeyring(),
      context,
      plaintext: new TextEncoder().encode('kms failure fixture'),
    });
    const failingService = serviceWith(
      keyManagement({ failUnwrap: true }),
      fakeNonceState([envelopeCryptoIds.nonceB]),
    );
    await expect(
      failingService.encrypt({
        keyring: envelopeKeyring(),
        context,
        plaintext: new Uint8Array([1]),
      }),
    ).rejects.toBeInstanceOf(FakeKeyManagementError);
    await expect(
      failingService.decrypt({
        keyring: envelopeKeyring(),
        context,
        ciphertext,
      }),
    ).rejects.toBeInstanceOf(FakeKeyManagementError);
  });

  it('generates deterministic fake data keys without exposing raw bytes', async () => {
    const kms = keyManagement();
    const generated = await kms.generateDataKey({
      vaultId: controlPlaneIds.vaultA,
      dekVersion: envelopeCryptoIds.dekVersion1,
    });
    expect(generated.metadata).toEqual(envelopeDekMetadata(1));
    expect(JSON.stringify(kms)).not.toContain('17,17,17');
    generated.key.destroy();
  });
});

function keyManagement(
  input: { readonly failUnwrap?: boolean } = {},
): KeyManagementPort {
  return createFakeKeyManagement({
    records: [
      {
        metadata: envelopeDekMetadata(1),
        keyBytes: envelopeKeyBytes.version1,
      },
      {
        metadata: envelopeDekMetadata(2),
        keyBytes: envelopeKeyBytes.version2,
      },
    ],
    ...(input.failUnwrap === undefined ? {} : { failUnwrap: input.failUnwrap }),
  });
}

function serviceWith(
  keyManagementPort: KeyManagementPort,
  nonceState: {
    readonly generator: NonceGeneratorPort;
    readonly reservations: NonceReservationPort;
  },
) {
  return createEnvelopeEncryptionService({
    keyManagement: keyManagementPort,
    nonceGenerator: nonceState.generator,
    nonceReservations: nonceState.reservations,
    aesGcm: webCryptoAes256Gcm,
  });
}

function fakeNonceState(
  nonces: readonly unknown[],
  reserved = new Set<string>(),
) {
  let index = 0;
  return {
    generator: {
      async createNonce() {
        const nonce = nonces[index];
        index += 1;
        if (nonce === undefined) throw new Error('fake nonce source exhausted');
        return nonce;
      },
    },
    reservations: {
      async reserve(input) {
        const key = `${input.vaultId}:${input.dekVersion}:${input.nonce}`;
        if (reserved.has(key)) return false;
        reserved.add(key);
        return true;
      },
    },
  } satisfies {
    readonly generator: NonceGeneratorPort;
    readonly reservations: NonceReservationPort;
  };
}

function replaceFirstCharacter(value: string): string {
  return `${value[0] === 'A' ? 'B' : 'A'}${value.slice(1)}`;
}
