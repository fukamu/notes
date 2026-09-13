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
