import type { VaultId } from '../../lib/domain/identity';
import type { DekVersion, VaultDekKeyring } from '../crypto/core';
import type { EncryptedObjectMetadata, OpaqueObjectKey } from './core';

export const maximumReencryptionBatchSize = 100;

export type EncryptedObjectReencryptionPosition = Pick<
  EncryptedObjectMetadata,
  'object' | 'objectRevision'
>;

export type EncryptedObjectReencryptionCheckpoint = {
  readonly targetVersion: DekVersion;
  readonly after: EncryptedObjectReencryptionPosition | null;
};

export type EncryptedObjectReencryptionInventory = {
  readonly routePresent: boolean;
  readonly olderObjects: number;
  readonly targetObjects: number;
  readonly newerObjects: number;
  readonly olderWriteIntents: number;
  readonly newerWriteIntents: number;
};

export type EncryptedObjectReencryptionRequestPlan =
  | {
      readonly kind: 'accepted';
      readonly targetVersion: DekVersion;
      readonly checkpoint: EncryptedObjectReencryptionCheckpoint;
      readonly limit: number;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'vault-mismatch'
        | 'checkpoint-target-mismatch'
        | 'invalid-limit'
        | 'invalid-timestamp';
    };

export type EncryptedObjectReencryptionInventoryPlan =
  | { readonly kind: 'completed' }
  | { readonly kind: 'scan' }
  | { readonly kind: 'wait-for-pending-writes' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'route-not-found'
        | 'invalid-inventory'
        | 'newer-version';
    };

export type EncryptedObjectReencryptionCandidatePlan =
  | {
      readonly kind: 'accepted';
      readonly replacement: EncryptedObjectMetadata;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'candidate-not-older'
        | 'object-key-reuse'
        | 'invalid-ciphertext-size';
    };

export function planEncryptedObjectReencryptionRequest(input: {
  readonly vaultId: VaultId;
  readonly keyring: VaultDekKeyring;
  readonly checkpoint?: EncryptedObjectReencryptionCheckpoint;
  readonly limit: number;
  readonly performedAt: number;
}): EncryptedObjectReencryptionRequestPlan {
  if (input.keyring.vaultId !== input.vaultId) {
    return { kind: 'rejected', reason: 'vault-mismatch' };
  }
  if (
    !Number.isSafeInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > maximumReencryptionBatchSize
  ) {
    return { kind: 'rejected', reason: 'invalid-limit' };
  }
  if (!Number.isSafeInteger(input.performedAt) || input.performedAt < 0) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  if (
    input.checkpoint !== undefined &&
    input.checkpoint.targetVersion !== input.keyring.writeVersion
  ) {
    return { kind: 'rejected', reason: 'checkpoint-target-mismatch' };
  }
  return {
    kind: 'accepted',
    targetVersion: input.keyring.writeVersion,
    checkpoint: input.checkpoint ?? {
      targetVersion: input.keyring.writeVersion,
      after: null,
    },
    limit: input.limit,
  };
}

export function evaluateEncryptedObjectReencryptionInventory(
  inventory: EncryptedObjectReencryptionInventory,
): EncryptedObjectReencryptionInventoryPlan {
  if (!inventory.routePresent) {
    return { kind: 'rejected', reason: 'route-not-found' };
  }
  if (
    !validCount(inventory.olderObjects) ||
    !validCount(inventory.targetObjects) ||
    !validCount(inventory.newerObjects) ||
    !validCount(inventory.olderWriteIntents) ||
    !validCount(inventory.newerWriteIntents)
  ) {
    return { kind: 'rejected', reason: 'invalid-inventory' };
  }
  if (inventory.newerObjects > 0 || inventory.newerWriteIntents > 0) {
    return { kind: 'rejected', reason: 'newer-version' };
  }
  if (inventory.olderObjects > 0) return { kind: 'scan' };
  return inventory.olderWriteIntents > 0
    ? { kind: 'wait-for-pending-writes' }
    : { kind: 'completed' };
}

export function planEncryptedObjectReencryptionCandidate(input: {
  readonly candidate: EncryptedObjectMetadata;
  readonly targetVersion: DekVersion;
  readonly replacementObjectKey: OpaqueObjectKey;
  readonly replacementCiphertextBytes: number;
}): EncryptedObjectReencryptionCandidatePlan {
  if (input.candidate.dekVersion >= input.targetVersion) {
    return { kind: 'rejected', reason: 'candidate-not-older' };
  }
  if (input.candidate.objectKey === input.replacementObjectKey) {
    return { kind: 'rejected', reason: 'object-key-reuse' };
  }
  if (
    !Number.isSafeInteger(input.replacementCiphertextBytes) ||
    input.replacementCiphertextBytes < 1 ||
    input.replacementCiphertextBytes > 134_217_728
  ) {
    return { kind: 'rejected', reason: 'invalid-ciphertext-size' };
  }
  return {
    kind: 'accepted',
    replacement: {
      ...input.candidate,
      objectKey: input.replacementObjectKey,
      ciphertextBytes: input.replacementCiphertextBytes,
      dekVersion: input.targetVersion,
    },
  };
}

export function reencryptionPositionFor(
  metadata: EncryptedObjectMetadata,
): EncryptedObjectReencryptionPosition {
  return {
    object: metadata.object,
    objectRevision: metadata.objectRevision,
  };
}

export function sameEncryptedObjectMetadata(
  left: EncryptedObjectMetadata,
  right: EncryptedObjectMetadata,
): boolean {
  return (
    left.object.kind === right.object.kind &&
    left.object.objectId === right.object.objectId &&
    left.objectRevision === right.objectRevision &&
    left.writeId === right.writeId &&
    left.objectKey === right.objectKey &&
    left.plaintextBytes === right.plaintextBytes &&
    left.ciphertextBytes === right.ciphertextBytes &&
    left.cryptoVersion === right.cryptoVersion &&
    left.dekVersion === right.dekVersion &&
    left.createdAt === right.createdAt
  );
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
