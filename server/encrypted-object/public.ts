import type { AccountId, VaultId } from '../../lib/domain/identity';
import type { EncryptedObjectMetadataPurgeEvaluation } from './core';

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
