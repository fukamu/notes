import { decodeOrThrow } from '../../lib/codec/core';
import {
  ENVELOPE_ALGORITHM,
  ENVELOPE_CRYPTO_VERSION,
  decodeEnvelopeCiphertext,
  encryptionNonceDecoder,
  selectDekForRead,
  selectDekForWrite,
  serializeEnvelopeAad,
  type EnvelopeCiphertext,
  type EnvelopeObjectContext,
  type VaultDekKeyring,
} from './core';
import type {
  Aes256GcmPort,
  KeyManagementPort,
  NonceGeneratorPort,
  NonceReservationPort,
} from './ports';

const maximumNonceReservationAttempts = 4;

export class EnvelopePolicyError extends Error {
  constructor() {
    super('Envelope operation rejected');
    this.name = 'EnvelopePolicyError';
  }
}

export class UniqueNonceUnavailableError extends Error {
  constructor() {
    super('Unique encryption nonce unavailable');
    this.name = 'UniqueNonceUnavailableError';
  }
}

export type EnvelopeEncryptionService = {
  encrypt(input: {
    readonly keyring: VaultDekKeyring;
    readonly context: EnvelopeObjectContext;
    readonly plaintext: Uint8Array;
  }): Promise<EnvelopeCiphertext>;
  decrypt(input: {
    readonly keyring: VaultDekKeyring;
    readonly context: EnvelopeObjectContext;
    readonly ciphertext: unknown;
  }): Promise<Uint8Array>;
};

export function createEnvelopeEncryptionService(input: {
  readonly keyManagement: KeyManagementPort;
  readonly nonceGenerator: NonceGeneratorPort;
  readonly nonceReservations: NonceReservationPort;
  readonly aesGcm: Aes256GcmPort;
}): EnvelopeEncryptionService {
  return {
    async encrypt(command) {
      const selection = selectDekForWrite(
        command.keyring,
        command.context.vaultId,
      );
      if (selection.kind === 'rejected') throw new EnvelopePolicyError();
      const key = await input.keyManagement.unwrapDataKey(selection.metadata);
      try {
        const nonce = await reserveUniqueNonce({
          generator: input.nonceGenerator,
          reservations: input.nonceReservations,
          vaultId: command.context.vaultId,
          dekVersion: selection.metadata.dekVersion,
        });
        const sealedPayload = await input.aesGcm.seal({
          key,
          nonce,
          aad: serializeEnvelopeAad({
            context: command.context,
            dekVersion: selection.metadata.dekVersion,
          }),
          plaintext: command.plaintext,
        });
        return {
          format: ENVELOPE_CRYPTO_VERSION,
          algorithm: ENVELOPE_ALGORITHM,
          dekVersion: selection.metadata.dekVersion,
          nonce,
          sealedPayload,
        };
      } finally {
        key.destroy();
      }
    },

    async decrypt(command) {
      const ciphertext = decodeEnvelopeCiphertext(command.ciphertext);
      const selection = selectDekForRead(
        command.keyring,
        command.context.vaultId,
        ciphertext.dekVersion,
      );
      if (selection.kind === 'rejected') throw new EnvelopePolicyError();
      const key = await input.keyManagement.unwrapDataKey(selection.metadata);
      try {
        return await input.aesGcm.open({
          key,
          nonce: ciphertext.nonce,
          aad: serializeEnvelopeAad({
            context: command.context,
            dekVersion: ciphertext.dekVersion,
          }),
          sealedPayload: ciphertext.sealedPayload,
        });
      } finally {
        key.destroy();
      }
    },
  };
}

async function reserveUniqueNonce(input: {
  readonly generator: NonceGeneratorPort;
  readonly reservations: NonceReservationPort;
  readonly vaultId: EnvelopeObjectContext['vaultId'];
  readonly dekVersion: VaultDekKeyring['writeVersion'];
}) {
  for (
    let attempt = 0;
    attempt < maximumNonceReservationAttempts;
    attempt += 1
  ) {
    const rawNonce: unknown = await input.generator.createNonce();
    const nonce = decodeOrThrow(
      encryptionNonceDecoder,
      rawNonce,
      'AES-GCM nonce source',
    );
    if (
      await input.reservations.reserve({
        vaultId: input.vaultId,
        dekVersion: input.dekVersion,
        nonce,
      })
    ) {
      return nonce;
    }
  }
  throw new UniqueNonceUnavailableError();
}
