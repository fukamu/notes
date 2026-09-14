import type { AccountId, VaultId } from '../../lib/domain/identity';
import type {
  EncryptedObjectMetadataPurgeEvaluation,
  VaultPrivateObjectDeletionBarrierEvaluation,
} from './core';

export {
  decodeVaultRecoveryManifest,
  evaluateVaultKeyRetirement,
  parseVaultRecoveryBackupId,
} from './recovery-core';
export { createVaultRecoveryDrillService } from './recovery-service';
export type {
  VaultBackupRetentionReference,
  VaultKeyRetirementEvaluation,
  VaultRecoveryDrillReceipt,
  VaultRecoveryManifest,
  VaultRecoveryScope,
} from './recovery-core';
export type { VaultRecoveryBackupPort } from './recovery-ports';
export type {
  VaultRecoveryDrillResult,
  VaultRecoveryDrillService,
} from './recovery-service';

export type EncryptedObjectMetadataPurgeScope = {
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
};

export type EncryptedObjectMetadataPurgeResult =
  EncryptedObjectMetadataPurgeEvaluation;

export type EncryptedObjectMetadataPurgePort = {
  purgeVaultMetadata(input: {
    readonly scope: EncryptedObjectMetadataPurgeScope;
    readonly requestedAt: number;
  }): Promise<EncryptedObjectMetadataPurgeResult>;
};

export type VaultPrivateObjectPurgeScope = EncryptedObjectMetadataPurgeScope;

export type VaultPrivateObjectPurgeResult =
  | {
      readonly kind: 'confirmed';
      readonly outcome: 'deleted' | 'already-empty';
    }
  | {
      readonly kind: 'retryable-failure';
      readonly reason:
        | 'objects-remaining'
        | 'storage-unavailable'
        | 'outbox-unavailable'
        | 'delete-confirmation-unavailable';
    }
  | {
      readonly kind: 'terminal-failure';
      readonly reason: 'owner-mismatch' | 'invalid-command';
    };

export type VaultPrivateObjectPurgePort = {
  purgeVaultPrivateObjects(input: {
    readonly scope: VaultPrivateObjectPurgeScope;
    readonly attemptedAt: number;
  }): Promise<VaultPrivateObjectPurgeResult>;
};

export type VaultPrivateObjectDeletionBarrierResult =
  VaultPrivateObjectDeletionBarrierEvaluation;

export type VaultPrivateObjectDeletionBarrierPort = {
  confirmVaultPrivateObjectDeletion(
    scope: VaultPrivateObjectPurgeScope,
  ): Promise<VaultPrivateObjectDeletionBarrierResult>;
};
