import {
  decodeOrThrow,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
} from '../../lib/codec/core';
import type { EnvelopeObject } from '../crypto/core';
import {
  ENVELOPE_CRYPTO_VERSION,
  type CryptoObjectRevision,
  type DekVersion,
  type EnvelopeCiphertext,
} from '../crypto/core';

declare const encryptedWriteIdBrand: unique symbol;
declare const opaqueObjectKeyBrand: unique symbol;

export type EncryptedWriteId = string & {
  readonly [encryptedWriteIdBrand]: 'EncryptedWriteId';
};

export type OpaqueObjectKey = string & {
  readonly [opaqueObjectKeyBrand]: 'OpaqueObjectKey';
};

export type EncryptedObjectMetadata = {
  readonly object: EnvelopeObject;
  readonly objectRevision: CryptoObjectRevision;
  readonly writeId: EncryptedWriteId;
  readonly objectKey: OpaqueObjectKey;
  readonly plaintextBytes: number;
  readonly ciphertextBytes: number;
  readonly cryptoVersion: typeof ENVELOPE_CRYPTO_VERSION;
  readonly dekVersion: DekVersion;
  readonly createdAt: number;
};

export type PendingEncryptedWrite = Omit<
  EncryptedObjectMetadata,
  'ciphertextBytes'
> & {
  readonly expectedRevision: CryptoObjectRevision | null;
};

export type EncryptedObjectWriteRequest = {
  readonly object: EnvelopeObject;
  readonly expectedRevision: CryptoObjectRevision | null;
  readonly nextRevision: CryptoObjectRevision;
  readonly writeId: EncryptedWriteId;
  readonly plaintextBytes: number;
  readonly dekVersion: DekVersion;
  readonly createdAt: number;
};

export type EncryptedObjectWritePlan =
  | { readonly kind: 'replay'; readonly metadata: EncryptedObjectMetadata }
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'idempotency-key-reuse'
        | 'unexpected-existing-object'
        | 'missing-object'
        | 'stale-revision'
        | 'invalid-next-revision'
        | 'invalid-timeline';
    };

export type PendingWriteResumePlan =
  | { readonly kind: 'accepted'; readonly intent: PendingEncryptedWrite }
  | {
      readonly kind: 'rejected';
      readonly reason: 'idempotency-key-reuse';
    };

export type StoredCiphertextPlan =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'ciphertext-size-mismatch'
        | 'crypto-version-mismatch'
        | 'dek-version-mismatch';
    };

export type PrivateObjectDescriptor = {
  readonly objectKey: OpaqueObjectKey;
  readonly createdAt: number;
};

export type DeleteOutboxEntry = {
  readonly objectKey: OpaqueObjectKey;
  readonly attemptCount: number;
  readonly nextAttemptAt: number;
  readonly createdAt: number;
};

export type DeleteAttemptPlan =
  | { readonly kind: 'complete' }
  | { readonly kind: 'retry'; readonly entry: DeleteOutboxEntry };

const uuidDecoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  (value) =>
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      value,
    ),
  'expected a UUID',
);

export const encryptedWriteIdDecoder: Decoder<EncryptedWriteId> =
  transformDecoder(uuidDecoder, (value) => value as EncryptedWriteId);

export const opaqueObjectKeyDecoder: Decoder<OpaqueObjectKey> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 50, maxLength: 50 }),
      (value) => /^obj_v1_[A-Za-z0-9_-]{43}$/.test(value),
      'expected an opaque v1 object key',
    ),
    (value) => value as OpaqueObjectKey,
  );

export const storedByteCountDecoder = safeIntegerDecoder({
  minimum: 0,
  maximum: 134_217_728,
});

export function parseEncryptedWriteId(input: unknown): EncryptedWriteId {
  return decodeOrThrow(encryptedWriteIdDecoder, input, 'EncryptedWriteId');
}

export function parseOpaqueObjectKey(input: unknown): OpaqueObjectKey {
  return decodeOrThrow(opaqueObjectKeyDecoder, input, 'OpaqueObjectKey');
}

export function planEncryptedObjectWrite(input: {
  readonly existingWrite: EncryptedObjectMetadata | undefined;
  readonly current: EncryptedObjectMetadata | undefined;
  readonly request: EncryptedObjectWriteRequest;
}): EncryptedObjectWritePlan {
  if (input.existingWrite !== undefined) {
    return metadataMatchesRequest(input.existingWrite, input.request)
      ? { kind: 'replay', metadata: input.existingWrite }
      : { kind: 'rejected', reason: 'idempotency-key-reuse' };
  }

  if (input.current === undefined) {
    if (input.request.expectedRevision !== null) {
      return { kind: 'rejected', reason: 'missing-object' };
    }
    if (input.request.nextRevision !== 1) {
      return { kind: 'rejected', reason: 'invalid-next-revision' };
    }
    return { kind: 'accepted' };
  }

  if (input.request.expectedRevision === null) {
    return { kind: 'rejected', reason: 'unexpected-existing-object' };
  }
  if (input.current.objectRevision !== input.request.expectedRevision) {
    return { kind: 'rejected', reason: 'stale-revision' };
  }
  if (input.request.nextRevision !== input.current.objectRevision + 1) {
    return { kind: 'rejected', reason: 'invalid-next-revision' };
  }
  if (input.request.createdAt < input.current.createdAt) {
    return { kind: 'rejected', reason: 'invalid-timeline' };
  }
  return { kind: 'accepted' };
}

export function planPendingWriteResume(
  intent: PendingEncryptedWrite,
  request: EncryptedObjectWriteRequest,
): PendingWriteResumePlan {
  return intentMatchesRequest(intent, request)
    ? { kind: 'accepted', intent }
    : { kind: 'rejected', reason: 'idempotency-key-reuse' };
}

export function planStoredCiphertext(input: {
  readonly metadata: Pick<
    EncryptedObjectMetadata | PendingEncryptedWrite,
    'cryptoVersion' | 'dekVersion'
  > & { readonly ciphertextBytes?: number };
  readonly ciphertext: EnvelopeCiphertext;
  readonly actualCiphertextBytes: number;
}): StoredCiphertextPlan {
  if (
    input.metadata.ciphertextBytes !== undefined &&
    input.metadata.ciphertextBytes !== input.actualCiphertextBytes
  ) {
    return { kind: 'rejected', reason: 'ciphertext-size-mismatch' };
  }
  if (input.metadata.cryptoVersion !== input.ciphertext.format) {
    return { kind: 'rejected', reason: 'crypto-version-mismatch' };
  }
  if (input.metadata.dekVersion !== input.ciphertext.dekVersion) {
    return { kind: 'rejected', reason: 'dek-version-mismatch' };
  }
  return { kind: 'accepted' };
}

export function planOrphanCollection(input: {
  readonly stored: readonly PrivateObjectDescriptor[];
  readonly protectedKeys: ReadonlySet<OpaqueObjectKey>;
  readonly scanStartedAt: number;
  readonly gracePeriodMs: number;
}): readonly OpaqueObjectKey[] {
  if (
    !Number.isSafeInteger(input.scanStartedAt) ||
    input.scanStartedAt < 0 ||
    !Number.isSafeInteger(input.gracePeriodMs) ||
    input.gracePeriodMs < 0
  ) {
    return [];
  }
  const cutoff = input.scanStartedAt - input.gracePeriodMs;
  return input.stored
    .filter(
      (entry) =>
        entry.createdAt <= cutoff && !input.protectedKeys.has(entry.objectKey),
    )
    .map((entry) => entry.objectKey)
    .sort();
}

export function planDeleteAttempt(input: {
  readonly entry: DeleteOutboxEntry;
  readonly succeeded: boolean;
  readonly attemptedAt: number;
  readonly retryDelayMs: number;
}): DeleteAttemptPlan {
  if (input.succeeded) return { kind: 'complete' };
  return {
    kind: 'retry',
    entry: {
      ...input.entry,
      attemptCount: input.entry.attemptCount + 1,
      nextAttemptAt: input.attemptedAt + input.retryDelayMs,
    },
  };
}

function metadataMatchesRequest(
  metadata: EncryptedObjectMetadata,
  request: EncryptedObjectWriteRequest,
): boolean {
  return (
    metadata.writeId === request.writeId &&
    sameObject(metadata.object, request.object) &&
    metadata.objectRevision === request.nextRevision &&
    metadata.plaintextBytes === request.plaintextBytes
  );
}

function intentMatchesRequest(
  intent: PendingEncryptedWrite,
  request: EncryptedObjectWriteRequest,
): boolean {
  return (
    intent.writeId === request.writeId &&
    sameObject(intent.object, request.object) &&
    intent.expectedRevision === request.expectedRevision &&
    intent.objectRevision === request.nextRevision &&
    intent.plaintextBytes === request.plaintextBytes &&
    intent.dekVersion === request.dekVersion
  );
}

export function sameObject(
  left: EnvelopeObject,
  right: EnvelopeObject,
): boolean {
  return left.kind === right.kind && left.objectId === right.objectId;
}
