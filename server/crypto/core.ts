import {
  arrayDecoder,
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
} from '../../lib/codec/core';
import type { CardId, ConflictId } from '../../lib/domain/id';
import { vaultIdDecoder, type VaultId } from '../../lib/domain/identity';

declare const dekVersionBrand: unique symbol;
declare const cryptoObjectRevisionBrand: unique symbol;
declare const encryptionNonceBrand: unique symbol;
declare const sealedPayloadBrand: unique symbol;
declare const wrappedDekBrand: unique symbol;

export const ENVELOPE_CRYPTO_VERSION = 'fukamu-envelope-aes-256-gcm/v1';
export const ENVELOPE_ALGORITHM = 'A256GCM';

export type DekVersion = number & {
  readonly [dekVersionBrand]: 'DekVersion';
};
export type CryptoObjectRevision = number & {
  readonly [cryptoObjectRevisionBrand]: 'CryptoObjectRevision';
};
export type EncryptionNonce = string & {
  readonly [encryptionNonceBrand]: 'EncryptionNonce';
};
export type SealedPayload = string & {
  readonly [sealedPayloadBrand]: 'SealedPayload';
};
export type WrappedDataEncryptionKey = string & {
  readonly [wrappedDekBrand]: 'WrappedDataEncryptionKey';
};

export type EnvelopeObject =
  | { readonly kind: 'card'; readonly objectId: CardId }
  | { readonly kind: 'conflict'; readonly objectId: ConflictId };

export type EnvelopeObjectContext = {
  readonly vaultId: VaultId;
  readonly object: EnvelopeObject;
  readonly objectRevision: CryptoObjectRevision;
};

export type VaultDekMetadata = {
  readonly vaultId: VaultId;
  readonly dekVersion: DekVersion;
  readonly kekKeyReference: string;
  readonly wrappedDek: WrappedDataEncryptionKey;
  readonly createdAt: number;
};

export type VaultDekKeyring = {
  readonly vaultId: VaultId;
  readonly writeVersion: DekVersion;
  readonly versions: readonly VaultDekMetadata[];
};

export type EnvelopeCiphertext = {
  readonly format: typeof ENVELOPE_CRYPTO_VERSION;
  readonly algorithm: typeof ENVELOPE_ALGORITHM;
  readonly dekVersion: DekVersion;
  readonly nonce: EncryptionNonce;
  readonly sealedPayload: SealedPayload;
};

export type VaultWrappedKeyFinalizationResult =
  | {
      readonly kind: 'confirmed';
      readonly outcome: 'deleted' | 'already-finalized';
    }
  | {
      readonly kind: 'retryable-failure';
      readonly reason: 'incomplete-finalization' | 'invalid-result';
    }
  | {
      readonly kind: 'terminal-failure';
      readonly reason: 'owner-mismatch';
    };

export type VaultWrappedKeyFinalizationCounts = {
  readonly ownerCount: number;
  readonly accountCount: number;
  readonly vaultCount: number;
  readonly wrappedKeyCount: number;
};

const positiveVersionDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: 2_147_483_647,
});
const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const base64UrlDecoder = (minimum: number, maximum: number) =>
  refineDecoder(
    stringDecoder({ minLength: minimum, maxLength: maximum }),
    (value) => /^[A-Za-z0-9_-]+$/.test(value),
    'expected unpadded base64url',
  );

export const dekVersionDecoder: Decoder<DekVersion> = transformDecoder(
  positiveVersionDecoder,
  (value) => value as DekVersion,
);
export const cryptoObjectRevisionDecoder: Decoder<CryptoObjectRevision> =
  transformDecoder(
    positiveVersionDecoder,
    (value) => value as CryptoObjectRevision,
  );
export const encryptionNonceDecoder: Decoder<EncryptionNonce> =
  transformDecoder(
    base64UrlDecoder(16, 16),
    (value) => value as EncryptionNonce,
  );
export const sealedPayloadDecoder: Decoder<SealedPayload> = transformDecoder(
  base64UrlDecoder(22, 16_384),
  (value) => value as SealedPayload,
);
export const wrappedDataEncryptionKeyDecoder: Decoder<WrappedDataEncryptionKey> =
  transformDecoder(
    base64UrlDecoder(1, 16_384),
    (value) => value as WrappedDataEncryptionKey,
  );

export const vaultDekMetadataDecoder: Decoder<VaultDekMetadata> =
  transformDecoder(
    objectDecoder({
      vaultId: vaultIdDecoder,
      dekVersion: dekVersionDecoder,
      kekKeyReference: stringDecoder({ minLength: 1, maxLength: 2_048 }),
      wrappedDek: wrappedDataEncryptionKeyDecoder,
      createdAt: timestampDecoder,
    }),
    (metadata): VaultDekMetadata => metadata,
  );

const keyringShapeDecoder = objectDecoder({
  vaultId: vaultIdDecoder,
  writeVersion: dekVersionDecoder,
  versions: arrayDecoder(vaultDekMetadataDecoder, {
    minLength: 1,
    maxLength: 64,
    uniqueBy: (metadata) => metadata.dekVersion,
  }),
});

export const vaultDekKeyringDecoder: Decoder<VaultDekKeyring> =
  transformDecoder(
    refineDecoder(
      keyringShapeDecoder,
      (keyring) =>
        keyring.versions.every(
          (metadata) => metadata.vaultId === keyring.vaultId,
        ) &&
        keyring.versions.some(
          (metadata) => metadata.dekVersion === keyring.writeVersion,
        ),
      'expected one Vault and an available write version',
    ),
    (keyring): VaultDekKeyring => keyring,
  );

export const envelopeCiphertextDecoder: Decoder<EnvelopeCiphertext> =
  transformDecoder(
    objectDecoder({
      format: literalDecoder(ENVELOPE_CRYPTO_VERSION),
      algorithm: literalDecoder(ENVELOPE_ALGORITHM),
      dekVersion: dekVersionDecoder,
      nonce: encryptionNonceDecoder,
      sealedPayload: sealedPayloadDecoder,
    }),
    (ciphertext): EnvelopeCiphertext => ciphertext,
  );

export function parseDekVersion(input: unknown): DekVersion {
  return decodeOrThrow(dekVersionDecoder, input, 'DEK version');
}

export function parseCryptoObjectRevision(
  input: unknown,
): CryptoObjectRevision {
  return decodeOrThrow(
    cryptoObjectRevisionDecoder,
    input,
    'crypto object revision',
  );
}

export function decodeVaultDekKeyring(input: unknown): VaultDekKeyring {
  return decodeOrThrow(vaultDekKeyringDecoder, input, 'Vault DEK keyring');
}

export function decodeEnvelopeCiphertext(input: unknown): EnvelopeCiphertext {
  return decodeOrThrow(envelopeCiphertextDecoder, input, 'envelope ciphertext');
}

export type DekSelection =
  | { readonly kind: 'selected'; readonly metadata: VaultDekMetadata }
  | {
      readonly kind: 'rejected';
      readonly reason: 'vault-mismatch' | 'unknown-dek-version';
    };

export function selectDekForWrite(
  keyring: VaultDekKeyring,
  vaultId: VaultId,
): DekSelection {
  return selectDek(keyring, vaultId, keyring.writeVersion);
}

export function selectDekForRead(
  keyring: VaultDekKeyring,
  vaultId: VaultId,
  dekVersion: DekVersion,
): DekSelection {
  return selectDek(keyring, vaultId, dekVersion);
}

function selectDek(
  keyring: VaultDekKeyring,
  vaultId: VaultId,
  version: DekVersion,
): DekSelection {
  if (keyring.vaultId !== vaultId) {
    return { kind: 'rejected', reason: 'vault-mismatch' };
  }
  const metadata = keyring.versions.find(
    (candidate) => candidate.dekVersion === version,
  );
  return metadata === undefined
    ? { kind: 'rejected', reason: 'unknown-dek-version' }
    : { kind: 'selected', metadata };
}

export type DekRotationPlan =
  | { readonly kind: 'rotated'; readonly keyring: VaultDekKeyring }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'vault-mismatch'
        | 'non-consecutive-version'
        | 'invalid-timeline';
    };

export function planDekRotation(
  keyring: VaultDekKeyring,
  next: VaultDekMetadata,
): DekRotationPlan {
  if (next.vaultId !== keyring.vaultId) {
    return { kind: 'rejected', reason: 'vault-mismatch' };
  }
  if (next.dekVersion !== keyring.writeVersion + 1) {
    return { kind: 'rejected', reason: 'non-consecutive-version' };
  }
  const current = keyring.versions.find(
    (metadata) => metadata.dekVersion === keyring.writeVersion,
  );
  if (current === undefined || next.createdAt < current.createdAt) {
    return { kind: 'rejected', reason: 'invalid-timeline' };
  }
  return {
    kind: 'rotated',
    keyring: {
      vaultId: keyring.vaultId,
      writeVersion: next.dekVersion,
      versions: [...keyring.versions, next],
    },
  };
}

export function serializeEnvelopeAad(input: {
  readonly context: EnvelopeObjectContext;
  readonly dekVersion: DekVersion;
}): string {
  return JSON.stringify([
    'fukamu-envelope-aad/v1',
    input.context.vaultId,
    input.context.object.kind,
    input.context.object.objectId,
    input.context.objectRevision,
    ENVELOPE_CRYPTO_VERSION,
    input.dekVersion,
  ]);
}

export function evaluateVaultWrappedKeyFinalization(input: {
  readonly before: VaultWrappedKeyFinalizationCounts;
  readonly deletedCount: number;
  readonly remainingCount: number;
}): VaultWrappedKeyFinalizationResult {
  const counts = [
    input.before.ownerCount,
    input.before.accountCount,
    input.before.vaultCount,
    input.before.wrappedKeyCount,
    input.deletedCount,
    input.remainingCount,
  ];
  if (counts.some((count) => !validCount(count))) {
    return { kind: 'retryable-failure', reason: 'invalid-result' };
  }
  if (
    input.before.ownerCount > 1 ||
    input.before.accountCount > 1 ||
    input.before.vaultCount > 1
  ) {
    return { kind: 'retryable-failure', reason: 'invalid-result' };
  }
  if (input.before.ownerCount === 0) {
    return input.before.accountCount === 0 &&
      input.before.vaultCount === 0 &&
      input.before.wrappedKeyCount === 0 &&
      input.deletedCount === 0 &&
      input.remainingCount === 0
      ? { kind: 'confirmed', outcome: 'already-finalized' }
      : { kind: 'terminal-failure', reason: 'owner-mismatch' };
  }
  if (input.before.accountCount !== 1 || input.before.vaultCount !== 1) {
    return { kind: 'terminal-failure', reason: 'owner-mismatch' };
  }
  if (
    input.remainingCount !== 0 ||
    input.deletedCount !== input.before.wrappedKeyCount
  ) {
    return { kind: 'retryable-failure', reason: 'incomplete-finalization' };
  }
  return {
    kind: 'confirmed',
    outcome:
      input.before.wrappedKeyCount === 0 ? 'already-finalized' : 'deleted',
  };
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
