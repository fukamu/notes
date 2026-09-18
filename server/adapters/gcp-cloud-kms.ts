import {
  booleanDecoder,
  decodeOrThrow,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
} from '../../lib/codec/core';
import {
  vaultDekMetadataDecoder,
  wrappedDataEncryptionKeyDecoder,
  type DekVersion,
  type VaultDekMetadata,
} from '../crypto/core';
import { createDataEncryptionKey } from '../crypto/key-material';
import type { KeyManagementPort } from '../crypto/ports';

const GCP_KMS_ENDPOINT = 'https://cloudkms.googleapis.com/v1';
const DEK_BYTE_LENGTH = 32;
const MAX_ACCESS_TOKEN_LENGTH = 8_192;
const MAX_KMS_CIPHERTEXT_LENGTH = 16_384;
const UINT32_MAXIMUM = 4_294_967_295;
const CRC32C_REVERSED_POLYNOMIAL = 0x82f63b78;
const WRAPPED_DEK_AAD_VERSION = 'fukamu-vault-dek-wrap/v1';

type ParsedCryptoKeyVersionResource = {
  readonly keyName: string;
  readonly versionName: string;
};

export type GcpCloudKmsEncryptRequest = {
  readonly keyVersionName: string;
  readonly plaintext: string;
  readonly additionalAuthenticatedData: string;
  readonly plaintextCrc32c: string;
  readonly additionalAuthenticatedDataCrc32c: string;
};

export type GcpCloudKmsDecryptRequest = {
  readonly keyName: string;
  readonly ciphertext: string;
  readonly additionalAuthenticatedData: string;
  readonly ciphertextCrc32c: string;
  readonly additionalAuthenticatedDataCrc32c: string;
};

export type GcpCloudKmsTransportPort = {
  encrypt(input: GcpCloudKmsEncryptRequest): Promise<unknown>;
  decrypt(input: GcpCloudKmsDecryptRequest): Promise<unknown>;
};

export type GcpCloudKmsEntropyPort = {
  createDataKeyBytes(): Promise<unknown>;
};

export type GcpCloudKmsClockPort = {
  now(): unknown;
};

export type GcpCloudKmsAccessTokenPort = {
  readAccessToken(): Promise<unknown>;
};

export class GcpCloudKmsConfigurationError extends Error {
  constructor() {
    super('GCP Cloud KMS configuration is unavailable');
    this.name = 'GcpCloudKmsConfigurationError';
  }
}

export class GcpCloudKmsOperationError extends Error {
  constructor() {
    super('GCP Cloud KMS operation failed');
    this.name = 'GcpCloudKmsOperationError';
  }
}

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const base64Decoder = refineDecoder(
  stringDecoder({ minLength: 4, maxLength: MAX_KMS_CIPHERTEXT_LENGTH }),
  isCanonicalBase64,
  'expected canonical base64',
);
const crc32cDecoder = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 1, maxLength: 10 }),
    (value) => {
      if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) return false;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) && parsed <= UINT32_MAXIMUM;
    },
    'expected a uint32 decimal string',
  ),
  Number,
);
const accessTokenDecoder = refineDecoder(
  stringDecoder({ minLength: 20, maxLength: MAX_ACCESS_TOKEN_LENGTH }),
  (value) => /^[\x21-\x7e]+$/u.test(value),
  'expected a visible ASCII OAuth access token',
);
const encryptResponseDecoder = objectDecoder(
  {
    name: stringDecoder({ minLength: 1, maxLength: 2_048 }),
    ciphertext: base64Decoder,
    ciphertextCrc32c: crc32cDecoder,
    verifiedPlaintextCrc32c: booleanDecoder,
    verifiedAdditionalAuthenticatedDataCrc32c: booleanDecoder,
  },
  { unknownFields: 'allow' },
);
const decryptResponseDecoder = objectDecoder(
  {
    plaintext: base64Decoder,
    plaintextCrc32c: crc32cDecoder,
  },
  { unknownFields: 'allow' },
);

export function createGcpCloudKmsKeyManagement(input: {
  readonly cryptoKeyVersionResource: unknown;
  readonly transport: GcpCloudKmsTransportPort;
  readonly entropy: GcpCloudKmsEntropyPort;
  readonly clock: GcpCloudKmsClockPort;
}): KeyManagementPort {
  const configuredResource = parseCryptoKeyVersionResource(
    input.cryptoKeyVersionResource,
  );

  return {
    async generateDataKey(command) {
      let rawKeyBytes: Uint8Array | undefined;
      try {
        const generated: unknown = await input.entropy.createDataKeyBytes();
        if (!(generated instanceof Uint8Array)) {
          throw new GcpCloudKmsOperationError();
        }
        rawKeyBytes = generated;
        if (rawKeyBytes.byteLength !== DEK_BYTE_LENGTH) {
          throw new GcpCloudKmsOperationError();
        }
        const createdAt = decodeOrThrow(
          timestampDecoder,
          input.clock.now(),
          'GCP Cloud KMS metadata timestamp',
        );
        const aad = encodeUtf8(
          serializeWrappedDekAad({
            vaultId: command.vaultId,
            dekVersion: command.dekVersion,
            keyVersionName: configuredResource.versionName,
          }),
        );
        const response = decodeOrThrow(
          encryptResponseDecoder,
          await input.transport.encrypt({
            keyVersionName: configuredResource.versionName,
            plaintext: encodeBase64(rawKeyBytes),
            additionalAuthenticatedData: encodeBase64(aad),
            plaintextCrc32c: String(crc32c(rawKeyBytes)),
            additionalAuthenticatedDataCrc32c: String(crc32c(aad)),
          }),
          'GCP Cloud KMS encrypt response',
        );
        if (
          response.name !== configuredResource.versionName ||
          !response.verifiedPlaintextCrc32c ||
          !response.verifiedAdditionalAuthenticatedDataCrc32c
        ) {
          throw new GcpCloudKmsOperationError();
        }
        const wrappedBytes = decodeBase64(response.ciphertext);
        if (crc32c(wrappedBytes) !== response.ciphertextCrc32c) {
          throw new GcpCloudKmsOperationError();
        }
        const metadata: VaultDekMetadata = {
          vaultId: command.vaultId,
          dekVersion: command.dekVersion,
          kekKeyReference: configuredResource.versionName,
          wrappedDek: decodeOrThrow(
            wrappedDataEncryptionKeyDecoder,
            encodeBase64Url(wrappedBytes),
            'GCP Cloud KMS wrapped DEK',
          ),
          createdAt,
        };
        return {
          metadata,
          key: createDataEncryptionKey(rawKeyBytes),
        };
      } catch {
        throw new GcpCloudKmsOperationError();
      } finally {
        rawKeyBytes?.fill(0);
      }
    },

    async unwrapDataKey(candidateMetadata) {
      let plaintext: Uint8Array | undefined;
      try {
        const metadata = decodeOrThrow(
          vaultDekMetadataDecoder,
          candidateMetadata,
          'GCP Cloud KMS wrapped DEK metadata',
        );
        const referencedResource = parseCryptoKeyVersionResource(
          metadata.kekKeyReference,
        );
        if (referencedResource.keyName !== configuredResource.keyName) {
          throw new GcpCloudKmsOperationError();
        }
        const wrappedBytes = decodeBase64Url(metadata.wrappedDek);
        const aad = encodeUtf8(
          serializeWrappedDekAad({
            vaultId: metadata.vaultId,
            dekVersion: metadata.dekVersion,
            keyVersionName: referencedResource.versionName,
          }),
        );
        const response = decodeOrThrow(
          decryptResponseDecoder,
          await input.transport.decrypt({
            keyName: referencedResource.keyName,
            ciphertext: encodeBase64(wrappedBytes),
            additionalAuthenticatedData: encodeBase64(aad),
            ciphertextCrc32c: String(crc32c(wrappedBytes)),
            additionalAuthenticatedDataCrc32c: String(crc32c(aad)),
          }),
          'GCP Cloud KMS decrypt response',
        );
        plaintext = decodeBase64(response.plaintext);
        if (
          plaintext.byteLength !== DEK_BYTE_LENGTH ||
          crc32c(plaintext) !== response.plaintextCrc32c
        ) {
          throw new GcpCloudKmsOperationError();
        }
        return createDataEncryptionKey(plaintext);
      } catch {
        throw new GcpCloudKmsOperationError();
      } finally {
        plaintext?.fill(0);
      }
    },
  };
}

export function createGcpCloudKmsRestTransport(input: {
  readonly accessToken: GcpCloudKmsAccessTokenPort;
  readonly fetch: typeof fetch;
}): GcpCloudKmsTransportPort {
  return {
    async encrypt(command) {
      return postJson(
        input,
        `${GCP_KMS_ENDPOINT}/${command.keyVersionName}:encrypt`,
        {
          plaintext: command.plaintext,
          additionalAuthenticatedData: command.additionalAuthenticatedData,
          plaintextCrc32c: command.plaintextCrc32c,
          additionalAuthenticatedDataCrc32c:
            command.additionalAuthenticatedDataCrc32c,
        },
      );
    },
    async decrypt(command) {
      return postJson(input, `${GCP_KMS_ENDPOINT}/${command.keyName}:decrypt`, {
        ciphertext: command.ciphertext,
        additionalAuthenticatedData: command.additionalAuthenticatedData,
        ciphertextCrc32c: command.ciphertextCrc32c,
        additionalAuthenticatedDataCrc32c:
          command.additionalAuthenticatedDataCrc32c,
      });
    },
  };
}

export const webCryptoGcpCloudKmsEntropy: GcpCloudKmsEntropyPort = {
  async createDataKeyBytes() {
    return crypto.getRandomValues(new Uint8Array(DEK_BYTE_LENGTH));
  },
};

export const systemGcpCloudKmsClock: GcpCloudKmsClockPort = {
  now() {
    return Date.now();
  },
};

async function postJson(
  input: {
    readonly accessToken: GcpCloudKmsAccessTokenPort;
    readonly fetch: typeof fetch;
  },
  url: string,
  body: Readonly<Record<string, string>>,
): Promise<unknown> {
  try {
    const token = decodeOrThrow(
      accessTokenDecoder,
      await input.accessToken.readAccessToken(),
      'GCP Cloud KMS access token',
    );
    const response = await input.fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new GcpCloudKmsOperationError();
    const decoded: unknown = await response.json();
    return decoded;
  } catch {
    throw new GcpCloudKmsOperationError();
  }
}

function parseCryptoKeyVersionResource(
  input: unknown,
): ParsedCryptoKeyVersionResource {
  if (typeof input !== 'string' || input.length > 2_048) {
    throw new GcpCloudKmsConfigurationError();
  }
  const match =
    /^(projects\/(?:[a-z][a-z0-9-]{4,28}[a-z0-9]|[0-9]{6,30})\/locations\/[a-z0-9-]{1,63}\/keyRings\/[A-Za-z0-9_-]{1,63}\/cryptoKeys\/[A-Za-z0-9_-]{1,63})\/cryptoKeyVersions\/[1-9][0-9]{0,18}$/u.exec(
      input,
    );
  const keyName = match?.[1];
  if (keyName === undefined) throw new GcpCloudKmsConfigurationError();
  return { keyName, versionName: input };
}

function serializeWrappedDekAad(input: {
  readonly vaultId: VaultDekMetadata['vaultId'];
  readonly dekVersion: DekVersion;
  readonly keyVersionName: string;
}): string {
  return JSON.stringify([
    WRAPPED_DEK_AAD_VERSION,
    input.vaultId,
    input.dekVersion,
    input.keyVersionName,
  ]);
}

function encodeUtf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
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

function decodeBase64(value: string): Uint8Array {
  if (!isCanonicalBase64(value)) throw new GcpCloudKmsOperationError();
  try {
    const binary = atob(value);
    const output = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) {
      output[index] = binary.charCodeAt(index);
    }
    if (encodeBase64(output) !== value) throw new GcpCloudKmsOperationError();
    return output;
  } catch {
    throw new GcpCloudKmsOperationError();
  }
}

function decodeBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]{1,16384}$/u.test(value)) {
    throw new GcpCloudKmsOperationError();
  }
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  return decodeBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
}

function isCanonicalBase64(value: string): boolean {
  return (
    value.length % 4 === 0 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  );
}

function crc32c(bytes: Uint8Array): number {
  let crc = UINT32_MAXIMUM;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? CRC32C_REVERSED_POLYNOMIAL : 0);
    }
  }
  return (crc ^ UINT32_MAXIMUM) >>> 0;
}
