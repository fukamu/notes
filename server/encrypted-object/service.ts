import { decodeOrThrow } from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import {
  decodeEnvelopeCiphertext,
  ENVELOPE_CRYPTO_VERSION,
  type CryptoObjectRevision,
  type EnvelopeCiphertext,
  type EnvelopeObject,
  type VaultDekKeyring,
} from '../crypto/core';
import type { EnvelopeEncryptionService } from '../crypto/envelope-service';
import {
  opaqueObjectKeyDecoder,
  planDeleteAttempt,
  planEncryptedObjectWrite,
  planOrphanCollection,
  planPendingWriteResume,
  planStoredCiphertext,
  storedByteCountDecoder,
  type EncryptedObjectMetadata,
  type EncryptedWriteId,
  type PendingEncryptedWrite,
} from './core';
import type {
  EncryptedObjectMetadataRepository,
  OpaqueObjectKeyGeneratorPort,
  PrivateObjectStoragePort,
} from './ports';

export class EncryptedObjectIntegrityError extends Error {
  constructor() {
    super('Encrypted object integrity validation failed');
    this.name = 'EncryptedObjectIntegrityError';
  }
}

export class EncryptedObjectStorageConflictError extends Error {
  constructor() {
    super('Immutable encrypted object already has different content');
    this.name = 'EncryptedObjectStorageConflictError';
  }
}

export type EncryptedObjectWriteResult =
  | {
      readonly kind: 'stored' | 'replayed';
      readonly metadata: EncryptedObjectMetadata;
    }
  | {
      readonly kind: 'not-applied';
      readonly reason:
        | 'idempotency-key-reuse'
        | 'unexpected-existing-object'
        | 'missing-object'
        | 'stale-revision'
        | 'invalid-next-revision'
        | 'invalid-timeline'
        | 'ciphertext-limit'
        | 'cas-conflict';
    };

export type EncryptedObjectReadResult =
  | { readonly kind: 'found'; readonly plaintext: Uint8Array }
  | { readonly kind: 'not-found' };

export type EncryptedObjectService = {
  write(input: {
    readonly object: EnvelopeObject;
    readonly expectedRevision: CryptoObjectRevision | null;
    readonly nextRevision: CryptoObjectRevision;
    readonly writeId: EncryptedWriteId;
    readonly plaintext: Uint8Array;
    readonly keyring: VaultDekKeyring;
    readonly createdAt: number;
  }): Promise<EncryptedObjectWriteResult>;
  read(input: {
    readonly object: EnvelopeObject;
    readonly keyring: VaultDekKeyring;
  }): Promise<EncryptedObjectReadResult>;
  readRevision(input: {
    readonly object: EnvelopeObject;
    readonly objectRevision: CryptoObjectRevision;
    readonly keyring: VaultDekKeyring;
  }): Promise<EncryptedObjectReadResult>;
  collectOrphans(input: {
    readonly scanStartedAt: number;
    readonly gracePeriodMs: number;
  }): Promise<{ readonly enqueued: number }>;
  drainDeleteOutbox(input: {
    readonly now: number;
    readonly retryDelayMs: number;
    readonly limit: number;
  }): Promise<{ readonly completed: number; readonly retried: number }>;
};

export function createEncryptedObjectService(input: {
  readonly context: VaultContext;
  readonly metadata: EncryptedObjectMetadataRepository;
  readonly objects: PrivateObjectStoragePort;
  readonly objectKeys: OpaqueObjectKeyGeneratorPort;
  readonly encryption: EnvelopeEncryptionService;
  readonly maximumCiphertextBytes?: number;
}): EncryptedObjectService {
  const maximumCiphertextBytes =
    input.maximumCiphertextBytes === undefined
      ? undefined
      : decodeOrThrow(
          storedByteCountDecoder,
          input.maximumCiphertextBytes,
          'encrypted object ciphertext limit',
        );
  return {
    async write(command) {
      const plaintextBytes = decodeOrThrow(
        storedByteCountDecoder,
        command.plaintext.byteLength,
        'encrypted object plaintext size',
      );
      const request = {
        object: command.object,
        expectedRevision: command.expectedRevision,
        nextRevision: command.nextRevision,
        writeId: command.writeId,
        plaintextBytes,
        dekVersion: command.keyring.writeVersion,
        createdAt: command.createdAt,
      } as const;
      const existingWrite = await input.metadata.findByWriteId(command.writeId);
      if (existingWrite !== undefined) {
        const plan = planEncryptedObjectWrite({
          existingWrite,
          current: undefined,
          request,
        });
        if (plan.kind === 'replay') {
          if (
            maximumCiphertextBytes !== undefined &&
            plan.metadata.ciphertextBytes > maximumCiphertextBytes
          ) {
            return { kind: 'not-applied', reason: 'ciphertext-limit' };
          }
          return { kind: 'replayed', metadata: plan.metadata };
        }
        if (plan.kind === 'rejected') {
          return { kind: 'not-applied', reason: plan.reason };
        }
        throw new EncryptedObjectIntegrityError();
      }

      const existingIntent = await input.metadata.findIntent(command.writeId);
      let intent: PendingEncryptedWrite;
      if (existingIntent !== undefined) {
        const resume = planPendingWriteResume(existingIntent, request);
        if (resume.kind === 'rejected') {
          return { kind: 'not-applied', reason: resume.reason };
        }
        intent = resume.intent;
      } else {
        const current = await input.metadata.findCurrent(command.object);
        const plan = planEncryptedObjectWrite({
          existingWrite: undefined,
          current,
          request,
        });
        if (plan.kind === 'rejected') {
          return { kind: 'not-applied', reason: plan.reason };
        }
        if (plan.kind === 'replay') throw new EncryptedObjectIntegrityError();
        const objectKey = decodeOrThrow(
          opaqueObjectKeyDecoder,
          await input.objectKeys.createObjectKey(),
          'opaque encrypted object key source',
        );
        const proposedIntent: PendingEncryptedWrite = {
          object: command.object,
          expectedRevision: command.expectedRevision,
          objectRevision: command.nextRevision,
          writeId: command.writeId,
          objectKey,
          plaintextBytes,
          cryptoVersion: ENVELOPE_CRYPTO_VERSION,
          dekVersion: command.keyring.writeVersion,
          createdAt: command.createdAt,
        };
        const reservation = await input.metadata.reserveIntent(proposedIntent);
        if (reservation.kind === 'conflict') {
          return { kind: 'not-applied', reason: 'cas-conflict' };
        }
        const resume = planPendingWriteResume(reservation.intent, request);
        if (resume.kind === 'rejected') {
          return { kind: 'not-applied', reason: resume.reason };
        }
        intent = resume.intent;
      }

      let storedBytes = await input.objects.get(intent.objectKey);
      let authenticateExistingObject = storedBytes !== undefined;
      if (storedBytes === undefined) {
        const ciphertext = await input.encryption.encrypt({
          keyring: command.keyring,
          context: {
            vaultId: input.context.vaultId,
            object: intent.object,
            objectRevision: intent.objectRevision,
          },
          plaintext: command.plaintext,
        });
        storedBytes = encodeEncryptedObjectCiphertext(ciphertext);
        if (
          maximumCiphertextBytes !== undefined &&
          storedBytes.byteLength > maximumCiphertextBytes
        ) {
          await input.metadata.abandonIntent({
            intent,
            requestedAt: command.createdAt,
          });
          return { kind: 'not-applied', reason: 'ciphertext-limit' };
        }
        const put = await input.objects.putIfAbsent({
          objectKey: intent.objectKey,
          bytes: storedBytes,
          createdAt: intent.createdAt,
        });
        if (put.kind === 'conflict') {
          throw new EncryptedObjectStorageConflictError();
        }
        if (put.kind === 'already-present') {
          const existingBytes = await input.objects.get(intent.objectKey);
          if (existingBytes === undefined)
            throw new EncryptedObjectIntegrityError();
          storedBytes = existingBytes;
          authenticateExistingObject = true;
        }
      }

      if (
        maximumCiphertextBytes !== undefined &&
        storedBytes.byteLength > maximumCiphertextBytes
      ) {
        await input.metadata.abandonIntent({
          intent,
          requestedAt: command.createdAt,
        });
        return { kind: 'not-applied', reason: 'ciphertext-limit' };
      }

      const ciphertext = decodeEncryptedObjectCiphertext(storedBytes);
      const storedPlan = planStoredCiphertext({
        metadata: intent,
        ciphertext,
        actualCiphertextBytes: storedBytes.byteLength,
      });
      if (storedPlan.kind === 'rejected') {
        throw new EncryptedObjectIntegrityError();
      }
      if (authenticateExistingObject) {
        let authenticatedPlaintext: Uint8Array;
        try {
          authenticatedPlaintext = await input.encryption.decrypt({
            keyring: command.keyring,
            context: {
              vaultId: input.context.vaultId,
              object: intent.object,
              objectRevision: intent.objectRevision,
            },
            ciphertext,
          });
        } catch {
          throw new EncryptedObjectIntegrityError();
        }
        if (!bytesEqual(authenticatedPlaintext, command.plaintext)) {
          throw new EncryptedObjectIntegrityError();
        }
      }
      const commit = await input.metadata.commitIntent({
        intent,
        ciphertextBytes: storedBytes.byteLength,
      });
      if (commit.kind === 'not-applied') {
        await input.metadata.abandonIntent({
          intent,
          requestedAt: command.createdAt,
        });
        return { kind: 'not-applied', reason: 'cas-conflict' };
      }
      return { kind: 'stored', metadata: commit.metadata };
    },

    async read(command) {
      const metadata = await input.metadata.findCurrent(command.object);
      return readMetadata(input, command.keyring, metadata);
    },

    async readRevision(command) {
      const metadata = await input.metadata.findRevision(
        command.object,
        command.objectRevision,
      );
      return readMetadata(input, command.keyring, metadata);
    },

    async collectOrphans(command) {
      const [stored, protectedKeys] = await Promise.all([
        input.objects.list(),
        input.metadata.listProtectedObjectKeys(),
      ]);
      const orphanKeys = planOrphanCollection({
        stored,
        protectedKeys,
        scanStartedAt: command.scanStartedAt,
        gracePeriodMs: command.gracePeriodMs,
      });
      for (const objectKey of orphanKeys) {
        await input.metadata.enqueueDelete({
          objectKey,
          requestedAt: command.scanStartedAt,
        });
      }
      return { enqueued: orphanKeys.length };
    },

    async drainDeleteOutbox(command) {
      const entries = await input.metadata.listReadyDeletes({
        now: command.now,
        limit: command.limit,
      });
      let completed = 0;
      let retried = 0;
      for (const entry of entries) {
        let succeeded = true;
        try {
          await input.objects.delete(entry.objectKey);
        } catch {
          succeeded = false;
        }
        const plan = planDeleteAttempt({
          entry,
          succeeded,
          attemptedAt: command.now,
          retryDelayMs: command.retryDelayMs,
        });
        if (plan.kind === 'complete') {
          await input.metadata.completeDelete(entry);
          completed += 1;
        } else {
          await input.metadata.rescheduleDelete(plan.entry);
          retried += 1;
        }
      }
      return { completed, retried };
    },
  };
}

async function readMetadata(
  input: {
    readonly context: VaultContext;
    readonly objects: PrivateObjectStoragePort;
    readonly encryption: EnvelopeEncryptionService;
  },
  keyring: VaultDekKeyring,
  metadata: EncryptedObjectMetadata | undefined,
): Promise<EncryptedObjectReadResult> {
  if (metadata === undefined) return { kind: 'not-found' };
  const bytes = await input.objects.get(metadata.objectKey);
  if (bytes === undefined) throw new EncryptedObjectIntegrityError();
  const ciphertext = decodeEncryptedObjectCiphertext(bytes);
  const plan = planStoredCiphertext({
    metadata,
    ciphertext,
    actualCiphertextBytes: bytes.byteLength,
  });
  if (plan.kind === 'rejected') throw new EncryptedObjectIntegrityError();
  const plaintext = await input.encryption.decrypt({
    keyring,
    context: {
      vaultId: input.context.vaultId,
      object: metadata.object,
      objectRevision: metadata.objectRevision,
    },
    ciphertext,
  });
  if (plaintext.byteLength !== metadata.plaintextBytes) {
    throw new EncryptedObjectIntegrityError();
  }
  return { kind: 'found', plaintext };
}

export function encodeEncryptedObjectCiphertext(
  ciphertext: EnvelopeCiphertext,
): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(ciphertext));
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}

export function decodeEncryptedObjectCiphertext(bytes: Uint8Array) {
  try {
    const candidate: unknown = JSON.parse(new TextDecoder().decode(bytes));
    return decodeEnvelopeCiphertext(candidate);
  } catch {
    throw new EncryptedObjectIntegrityError();
  }
}
