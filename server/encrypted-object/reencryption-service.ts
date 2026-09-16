import { decodeOrThrow } from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type { VaultDekKeyring } from '../crypto/core';
import type { EnvelopeEncryptionService } from '../crypto/envelope-service';
import { opaqueObjectKeyDecoder, planStoredCiphertext } from './core';
import type {
  OpaqueObjectKeyGeneratorPort,
  PrivateObjectStoragePort,
} from './ports';
import {
  evaluateEncryptedObjectReencryptionInventory,
  planEncryptedObjectReencryptionCandidate,
  planEncryptedObjectReencryptionRequest,
  reencryptionPositionFor,
  type EncryptedObjectReencryptionCheckpoint,
} from './reencryption-core';
import type { EncryptedObjectReencryptionRepository } from './reencryption-ports';
import {
  decodeEncryptedObjectCiphertext,
  encodeEncryptedObjectCiphertext,
  EncryptedObjectIntegrityError,
  EncryptedObjectStorageConflictError,
} from './service';

export class EncryptedObjectReencryptionIntegrityError extends Error {
  constructor() {
    super('Encrypted object re-encryption integrity validation failed');
    this.name = 'EncryptedObjectReencryptionIntegrityError';
  }
}

export type EncryptedObjectReencryptionBatchResult =
  | {
      readonly kind: 'completed';
      readonly processed: number;
    }
  | {
      readonly kind: 'pending';
      readonly processed: number;
      readonly checkpoint: EncryptedObjectReencryptionCheckpoint;
      readonly reason:
        | 'page-limit'
        | 'restart-scan'
        | 'cas-conflict'
        | 'pending-writes';
    }
  | {
      readonly kind: 'rejected';
      readonly processed: number;
      readonly reason:
        | 'vault-mismatch'
        | 'checkpoint-target-mismatch'
        | 'invalid-limit'
        | 'invalid-timestamp'
        | 'route-not-found'
        | 'invalid-inventory'
        | 'newer-version';
    };

export type EncryptedObjectReencryptionService = {
  runBatch(input: {
    readonly keyring: VaultDekKeyring;
    readonly checkpoint?: EncryptedObjectReencryptionCheckpoint;
    readonly limit: number;
    readonly performedAt: number;
  }): Promise<EncryptedObjectReencryptionBatchResult>;
};

export function createEncryptedObjectReencryptionService(input: {
  readonly context: VaultContext;
  readonly repository: EncryptedObjectReencryptionRepository;
  readonly objects: PrivateObjectStoragePort;
  readonly objectKeys: OpaqueObjectKeyGeneratorPort;
  readonly encryption: EnvelopeEncryptionService;
}): EncryptedObjectReencryptionService {
  return {
    async runBatch(command) {
      const request = planEncryptedObjectReencryptionRequest({
        vaultId: input.context.vaultId,
        keyring: command.keyring,
        ...(command.checkpoint === undefined
          ? {}
          : { checkpoint: command.checkpoint }),
        limit: command.limit,
        performedAt: command.performedAt,
      });
      if (request.kind === 'rejected') {
        return { kind: 'rejected', processed: 0, reason: request.reason };
      }

      const initialInventory = evaluateEncryptedObjectReencryptionInventory(
        await input.repository.inventory(request.targetVersion),
      );
      if (initialInventory.kind === 'rejected') {
        return {
          kind: 'rejected',
          processed: 0,
          reason: initialInventory.reason,
        };
      }
      if (initialInventory.kind === 'completed') {
        return { kind: 'completed', processed: 0 };
      }
      if (initialInventory.kind === 'wait-for-pending-writes') {
        return {
          kind: 'pending',
          processed: 0,
          checkpoint: request.checkpoint,
          reason: 'pending-writes',
        };
      }

      const candidates = await input.repository.listCandidates({
        targetVersion: request.targetVersion,
        after: request.checkpoint.after,
        limit: request.limit,
      });
      if (candidates.length === 0) {
        return {
          kind: 'pending',
          processed: 0,
          checkpoint: {
            targetVersion: request.targetVersion,
            after: null,
          },
          reason: 'restart-scan',
        };
      }

      let processed = 0;
      let checkpoint = request.checkpoint;
      for (const candidate of candidates) {
        const storedBytes = await input.objects.get(candidate.objectKey);
        if (storedBytes === undefined)
          throw new EncryptedObjectIntegrityError();
        const ciphertext = decodeEncryptedObjectCiphertext(storedBytes);
        const storedPlan = planStoredCiphertext({
          metadata: candidate,
          ciphertext,
          actualCiphertextBytes: storedBytes.byteLength,
        });
        if (storedPlan.kind === 'rejected') {
          throw new EncryptedObjectReencryptionIntegrityError();
        }

        let plaintext: Uint8Array;
        try {
          plaintext = await input.encryption.decrypt({
            keyring: command.keyring,
            context: {
              vaultId: input.context.vaultId,
              object: candidate.object,
              objectRevision: candidate.objectRevision,
            },
            ciphertext,
          });
        } catch {
          throw new EncryptedObjectReencryptionIntegrityError();
        }
        if (plaintext.byteLength !== candidate.plaintextBytes) {
          throw new EncryptedObjectReencryptionIntegrityError();
        }

        const replacementCiphertext = await input.encryption.encrypt({
          keyring: command.keyring,
          context: {
            vaultId: input.context.vaultId,
            object: candidate.object,
            objectRevision: candidate.objectRevision,
          },
          plaintext,
        });
        const replacementBytes = encodeEncryptedObjectCiphertext(
          replacementCiphertext,
        );
        const replacementObjectKey = decodeOrThrow(
          opaqueObjectKeyDecoder,
          await input.objectKeys.createObjectKey(),
          'opaque re-encrypted object key source',
        );
        const candidatePlan = planEncryptedObjectReencryptionCandidate({
          candidate,
          targetVersion: request.targetVersion,
          replacementObjectKey,
          replacementCiphertextBytes: replacementBytes.byteLength,
        });
        if (candidatePlan.kind === 'rejected') {
          throw new EncryptedObjectReencryptionIntegrityError();
        }
        const replacementPlan = planStoredCiphertext({
          metadata: candidatePlan.replacement,
          ciphertext: replacementCiphertext,
          actualCiphertextBytes: replacementBytes.byteLength,
        });
        if (replacementPlan.kind === 'rejected') {
          throw new EncryptedObjectReencryptionIntegrityError();
        }

        const put = await input.objects.putIfAbsent({
          objectKey: replacementObjectKey,
          bytes: replacementBytes,
          createdAt: command.performedAt,
        });
        if (put.kind === 'conflict') {
          throw new EncryptedObjectStorageConflictError();
        }
        if (put.kind === 'already-present') {
          const existing = await input.objects.get(replacementObjectKey);
          if (
            existing === undefined ||
            !bytesEqual(existing, replacementBytes)
          ) {
            throw new EncryptedObjectStorageConflictError();
          }
        }

        const commit = await input.repository.commit({
          expected: candidate,
          replacement: candidatePlan.replacement,
          requestedAt: command.performedAt,
        });
        if (commit.kind === 'conflict') {
          return {
            kind: 'pending',
            processed,
            checkpoint,
            reason: 'cas-conflict',
          };
        }
        processed += 1;
        checkpoint = {
          targetVersion: request.targetVersion,
          after: reencryptionPositionFor(candidate),
        };
      }

      const finalInventory = evaluateEncryptedObjectReencryptionInventory(
        await input.repository.inventory(request.targetVersion),
      );
      if (finalInventory.kind === 'rejected') {
        return {
          kind: 'rejected',
          processed,
          reason: finalInventory.reason,
        };
      }
      if (finalInventory.kind === 'completed') {
        return { kind: 'completed', processed };
      }
      if (finalInventory.kind === 'wait-for-pending-writes') {
        return {
          kind: 'pending',
          processed,
          checkpoint,
          reason: 'pending-writes',
        };
      }
      if (candidates.length < request.limit) {
        return {
          kind: 'pending',
          processed,
          checkpoint: { targetVersion: request.targetVersion, after: null },
          reason: 'restart-scan',
        };
      }
      return {
        kind: 'pending',
        processed,
        checkpoint,
        reason: 'page-limit',
      };
    },
  };
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return (
    left.byteLength === right.byteLength &&
    left.every((value, index) => value === right[index])
  );
}
