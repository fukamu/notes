import { describe, expect, it } from 'vitest';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import {
  GcpCloudKmsConfigurationError,
  GcpCloudKmsOperationError,
  createGcpCloudKmsKeyManagement,
  createGcpCloudKmsRestTransport,
  type GcpCloudKmsDecryptRequest,
  type GcpCloudKmsEncryptRequest,
  type GcpCloudKmsTransportPort,
} from '@/server/adapters/gcp-cloud-kms';
import { parseDekVersion } from '@/server/crypto/core';

const keyName =
  'projects/fukamu-prod/locations/asia-northeast1/keyRings/fukamu-notes/cryptoKeys/vault-kek';
const keyVersionName = `${keyName}/cryptoKeyVersions/7`;
const otherKeyVersionName =
  'projects/fukamu-prod/locations/asia-northeast1/keyRings/fukamu-notes/cryptoKeys/other-kek/cryptoKeyVersions/7';
const dekVersion = parseDekVersion(1);
const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 1);

describe('GCP Cloud KMS key management adapter', () => {
  it('wraps a locally generated DEK with Vault-bound AAD and unwraps it', async () => {
    const transport = authenticatedFakeTransport();
    const entropyBytes = keyBytes.slice();
    const kms = createGcpCloudKmsKeyManagement({
      cryptoKeyVersionResource: keyVersionName,
      transport,
      entropy: {
        async createDataKeyBytes() {
          return entropyBytes;
        },
      },
      clock: { now: () => 1_725_000_000_000 },
    });

    const generated = await kms.generateDataKey({
      vaultId: controlPlaneIds.vaultA,
      dekVersion,
    });

    expect(generated.metadata).toEqual({
      vaultId: controlPlaneIds.vaultA,
      dekVersion,
      kekKeyReference: keyVersionName,
      wrappedDek: transport.wrappedDek,
      createdAt: 1_725_000_000_000,
    });
    expect(entropyBytes).toEqual(new Uint8Array(32));
    expect(transport.encryptRequests).toHaveLength(1);
    expect(transport.encryptRequests[0]).toMatchObject({
      keyVersionName,
      plaintext: encodeBase64(keyBytes),
    });
    expect(
      decodeBase64(
        transport.encryptRequests[0]?.additionalAuthenticatedData ?? '',
      ),
    ).toBe(
      JSON.stringify([
        'fukamu-vault-dek-wrap/v1',
        controlPlaneIds.vaultA,
        dekVersion,
        keyVersionName,
      ]),
    );
    await expect(readKey(generated.key)).resolves.toEqual(keyBytes);

    const unwrapped = await kms.unwrapDataKey(generated.metadata);
    await expect(readKey(unwrapped)).resolves.toEqual(keyBytes);
    expect(transport.decryptRequests).toHaveLength(1);
    expect(transport.decryptRequests[0]).toMatchObject({
      keyName,
      ciphertext: encodeBase64(decodeBase64Url(transport.wrappedDek)),
    });
    generated.key.destroy();
    unwrapped.destroy();
  });

  it('fails closed when Vault AAD or the configured CryptoKey is changed', async () => {
    const transport = authenticatedFakeTransport();
    const kms = keyManagementWith(transport);
    const generated = await kms.generateDataKey({
      vaultId: controlPlaneIds.vaultA,
      dekVersion,
    });

    await expect(
      kms.unwrapDataKey({
        ...generated.metadata,
        vaultId: controlPlaneIds.vaultB,
      }),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);
    await expect(
      kms.unwrapDataKey({
        ...generated.metadata,
        kekKeyReference: otherKeyVersionName,
      }),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);
    expect(transport.decryptRequests).toHaveLength(1);
    generated.key.destroy();
  });

  it('rejects unverified or corrupt provider responses and zeroizes source bytes', async () => {
    const source = keyBytes.slice();
    const transport: GcpCloudKmsTransportPort = {
      async encrypt() {
        return {
          name: keyVersionName,
          ciphertext: encodeBase64(new Uint8Array([1, 2, 3])),
          ciphertextCrc32c: '0',
          verifiedPlaintextCrc32c: true,
          verifiedAdditionalAuthenticatedDataCrc32c: true,
        };
      },
      async decrypt() {
        throw new Error('unexpected decrypt');
      },
    };
    const kms = createGcpCloudKmsKeyManagement({
      cryptoKeyVersionResource: keyVersionName,
      transport,
      entropy: {
        async createDataKeyBytes() {
          return source;
        },
      },
      clock: { now: () => 1_725_000_000_000 },
    });

    await expect(
      kms.generateDataKey({ vaultId: controlPlaneIds.vaultA, dekVersion }),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);
    expect(source).toEqual(new Uint8Array(32));

    const unverified = keyManagementWith({
      ...transport,
      async encrypt(command) {
        return {
          name: command.keyVersionName,
          ciphertext: encodeBase64(new Uint8Array([1, 2, 3])),
          ciphertextCrc32c: String(crc32c(new Uint8Array([1, 2, 3]))),
          verifiedPlaintextCrc32c: false,
          verifiedAdditionalAuthenticatedDataCrc32c: true,
        };
      },
    });
    await expect(
      unverified.generateDataKey({
        vaultId: controlPlaneIds.vaultA,
        dekVersion,
      }),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);

    const wrongVersion = keyManagementWith({
      ...transport,
      async encrypt() {
        const ciphertext = new Uint8Array([1, 2, 3]);
        return {
          name: `${keyName}/cryptoKeyVersions/8`,
          ciphertext: encodeBase64(ciphertext),
          ciphertextCrc32c: String(crc32c(ciphertext)),
          verifiedPlaintextCrc32c: true,
          verifiedAdditionalAuthenticatedDataCrc32c: true,
        };
      },
    });
    await expect(
      wrongVersion.generateDataKey({
        vaultId: controlPlaneIds.vaultA,
        dekVersion,
      }),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);
  });

  it('rejects corrupt or incorrectly sized unwrapped key material', async () => {
    const transport = authenticatedFakeTransport();
    const wrappingKms = keyManagementWith(transport);
    const generated = await wrappingKms.generateDataKey({
      vaultId: controlPlaneIds.vaultA,
      dekVersion,
    });
    const shortPlaintext = new Uint8Array([1, 2, 3]);
    const invalidUnwrapKms = keyManagementWith({
      ...transport,
      async decrypt() {
        return {
          plaintext: encodeBase64(shortPlaintext),
          plaintextCrc32c: String(crc32c(shortPlaintext)),
        };
      },
    });

    await expect(
      invalidUnwrapKms.unwrapDataKey(generated.metadata),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);

    const corruptChecksumKms = keyManagementWith({
      ...transport,
      async decrypt() {
        return {
          plaintext: encodeBase64(keyBytes),
          plaintextCrc32c: '0',
        };
      },
    });
    await expect(
      corruptChecksumKms.unwrapDataKey(generated.metadata),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);
    generated.key.destroy();
  });

  it('rejects invalid configuration and exposes no key or provider details in errors', async () => {
    expect(() =>
      createGcpCloudKmsKeyManagement({
        cryptoKeyVersionResource: `${keyName}/cryptoKeyVersions/0`,
        transport: authenticatedFakeTransport(),
        entropy: {
          async createDataKeyBytes() {
            return keyBytes.slice();
          },
        },
        clock: { now: () => 1_725_000_000_000 },
      }),
    ).toThrow(GcpCloudKmsConfigurationError);

    const sensitive = 'PRIVATE-PROVIDER-FAILURE';
    const kms = keyManagementWith({
      async encrypt() {
        throw new Error(sensitive);
      },
      async decrypt() {
        throw new Error(sensitive);
      },
    });
    const failure = await kms
      .generateDataKey({ vaultId: controlPlaneIds.vaultA, dekVersion })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GcpCloudKmsOperationError);
    expect(String(failure)).not.toContain(sensitive);
    expect(String(failure)).not.toContain(encodeBase64(keyBytes));
  });

  it('rejects invalid entropy or clock values before calling the provider', async () => {
    let providerCalls = 0;
    const transport: GcpCloudKmsTransportPort = {
      async encrypt() {
        providerCalls += 1;
        throw new Error('unexpected encrypt');
      },
      async decrypt() {
        throw new Error('unexpected decrypt');
      },
    };
    const invalidEntropy = createGcpCloudKmsKeyManagement({
      cryptoKeyVersionResource: keyVersionName,
      transport,
      entropy: {
        async createDataKeyBytes() {
          return new Uint8Array(31);
        },
      },
      clock: { now: () => 1_725_000_000_000 },
    });
    await expect(
      invalidEntropy.generateDataKey({
        vaultId: controlPlaneIds.vaultA,
        dekVersion,
      }),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);

    const source = keyBytes.slice();
    const invalidClock = createGcpCloudKmsKeyManagement({
      cryptoKeyVersionResource: keyVersionName,
      transport,
      entropy: {
        async createDataKeyBytes() {
          return source;
        },
      },
      clock: { now: () => -1 },
    });
    await expect(
      invalidClock.generateDataKey({
        vaultId: controlPlaneIds.vaultA,
        dekVersion,
      }),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);
    expect(providerCalls).toBe(0);
    expect(source).toEqual(new Uint8Array(32));
  });
});

describe('GCP Cloud KMS REST transport', () => {
  it('uses the versioned Encrypt and parent-key Decrypt endpoints', async () => {
    const calls: { readonly url: string; readonly init: RequestInit }[] = [];
    const fakeFetch: typeof fetch = async (resource, init) => {
      const url =
        typeof resource === 'string'
          ? resource
          : resource instanceof URL
            ? resource.href
            : resource.url;
      calls.push({ url, init: init ?? {} });
      return Response.json({ provider: 'response' });
    };
    const transport = createGcpCloudKmsRestTransport({
      accessToken: {
        async readAccessToken() {
          return 'token-value-with-safe-length';
        },
      },
      fetch: fakeFetch,
    });

    await expect(
      transport.encrypt({
        keyVersionName,
        plaintext: 'AQ==',
        additionalAuthenticatedData: 'Ag==',
        plaintextCrc32c: '1',
        additionalAuthenticatedDataCrc32c: '2',
      }),
    ).resolves.toEqual({ provider: 'response' });
    await transport.decrypt({
      keyName,
      ciphertext: 'Aw==',
      additionalAuthenticatedData: 'Ag==',
      ciphertextCrc32c: '3',
      additionalAuthenticatedDataCrc32c: '2',
    });

    expect(calls.map((call) => call.url)).toEqual([
      `https://cloudkms.googleapis.com/v1/${keyVersionName}:encrypt`,
      `https://cloudkms.googleapis.com/v1/${keyName}:decrypt`,
    ]);
    expect(calls[0]?.init).toMatchObject({
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: 'Bearer token-value-with-safe-length',
        'Content-Type': 'application/json',
      },
    });
    expect(calls[0]?.init.body).toBe(
      JSON.stringify({
        plaintext: 'AQ==',
        additionalAuthenticatedData: 'Ag==',
        plaintextCrc32c: '1',
        additionalAuthenticatedDataCrc32c: '2',
      }),
    );
  });

  it('fails closed without leaking the access token or provider response', async () => {
    let callCount = 0;
    const accessToken = 'sensitive-access-token-value';
    let status = 401;
    const failingFetch: typeof fetch = async () => {
      callCount += 1;
      return new Response('PRIVATE PROVIDER BODY', { status });
    };
    const transport = createGcpCloudKmsRestTransport({
      accessToken: {
        async readAccessToken() {
          return accessToken;
        },
      },
      fetch: failingFetch,
    });
    for (const responseStatus of [401, 403, 429, 500]) {
      status = responseStatus;
      const failure = await transport
        .encrypt({
          keyVersionName,
          plaintext: 'AQ==',
          additionalAuthenticatedData: 'Ag==',
          plaintextCrc32c: '1',
          additionalAuthenticatedDataCrc32c: '2',
        })
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(GcpCloudKmsOperationError);
      expect(String(failure)).not.toContain(accessToken);
      expect(String(failure)).not.toContain('PRIVATE PROVIDER BODY');
    }
    expect(callCount).toBe(4);

    const invalidTokenTransport = createGcpCloudKmsRestTransport({
      accessToken: {
        async readAccessToken() {
          return 'short';
        },
      },
      fetch: failingFetch,
    });
    await expect(
      invalidTokenTransport.decrypt({
        keyName,
        ciphertext: 'Aw==',
        additionalAuthenticatedData: 'Ag==',
        ciphertextCrc32c: '3',
        additionalAuthenticatedDataCrc32c: '2',
      }),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);
    expect(callCount).toBe(4);

    const privateFetchFailure = 'PRIVATE FETCH FAILURE';
    const throwingTransport = createGcpCloudKmsRestTransport({
      accessToken: {
        async readAccessToken() {
          return accessToken;
        },
      },
      fetch: async () => {
        throw new Error(privateFetchFailure);
      },
    });
    const thrown = await throwingTransport
      .decrypt({
        keyName,
        ciphertext: 'Aw==',
        additionalAuthenticatedData: 'Ag==',
        ciphertextCrc32c: '3',
        additionalAuthenticatedDataCrc32c: '2',
      })
      .catch((error: unknown) => error);
    expect(thrown).toBeInstanceOf(GcpCloudKmsOperationError);
    expect(String(thrown)).not.toContain(privateFetchFailure);

    const malformedResponseTransport = createGcpCloudKmsRestTransport({
      accessToken: {
        async readAccessToken() {
          return accessToken;
        },
      },
      fetch: async () => new Response('{', { status: 200 }),
    });
    await expect(
      malformedResponseTransport.encrypt({
        keyVersionName,
        plaintext: 'AQ==',
        additionalAuthenticatedData: 'Ag==',
        plaintextCrc32c: '1',
        additionalAuthenticatedDataCrc32c: '2',
      }),
    ).rejects.toBeInstanceOf(GcpCloudKmsOperationError);
  });
});

function keyManagementWith(transport: GcpCloudKmsTransportPort) {
  return createGcpCloudKmsKeyManagement({
    cryptoKeyVersionResource: keyVersionName,
    transport,
    entropy: {
      async createDataKeyBytes() {
        return keyBytes.slice();
      },
    },
    clock: { now: () => 1_725_000_000_000 },
  });
}

function authenticatedFakeTransport(): GcpCloudKmsTransportPort & {
  readonly encryptRequests: GcpCloudKmsEncryptRequest[];
  readonly decryptRequests: GcpCloudKmsDecryptRequest[];
  readonly wrappedDek: string;
} {
  const encryptRequests: GcpCloudKmsEncryptRequest[] = [];
  const decryptRequests: GcpCloudKmsDecryptRequest[] = [];
  const wrappedBytes = new TextEncoder().encode('wrapped-dek-ciphertext');
  const wrappedDek = encodeBase64Url(wrappedBytes);
  let expectedAad = '';
  let expectedPlaintext = '';
  return {
    encryptRequests,
    decryptRequests,
    wrappedDek,
    async encrypt(command) {
      encryptRequests.push(command);
      expectedAad = command.additionalAuthenticatedData;
      expectedPlaintext = command.plaintext;
      return {
        name: command.keyVersionName,
        ciphertext: encodeBase64(wrappedBytes),
        ciphertextCrc32c: String(crc32c(wrappedBytes)),
        verifiedPlaintextCrc32c: true,
        verifiedAdditionalAuthenticatedDataCrc32c: true,
      };
    },
    async decrypt(command) {
      decryptRequests.push(command);
      if (
        command.additionalAuthenticatedData !== expectedAad ||
        command.ciphertext !== encodeBase64(wrappedBytes)
      ) {
        throw new Error('authentication failed');
      }
      const plaintext = decodeBase64Bytes(expectedPlaintext);
      return {
        plaintext: expectedPlaintext,
        plaintextCrc32c: String(crc32c(plaintext)),
      };
    },
  };
}

async function readKey(key: {
  use<TResult>(
    operation: (bytes: Uint8Array) => Promise<TResult>,
  ): Promise<TResult>;
}): Promise<Uint8Array> {
  return key.use(async (bytes) => bytes.slice());
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function encodeBase64Url(bytes: Uint8Array): string {
  return encodeBase64(bytes)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');
}

function decodeBase64(value: string): string {
  return new TextDecoder().decode(decodeBase64Bytes(value));
}

function decodeBase64Bytes(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodeBase64Url(value: string): Uint8Array {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  return decodeBase64Bytes(
    base64.padEnd(Math.ceil(base64.length / 4) * 4, '='),
  );
}

function crc32c(bytes: Uint8Array): number {
  let crc = 4_294_967_295;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0x82f63b78 : 0);
    }
  }
  return (crc ^ 4_294_967_295) >>> 0;
}
