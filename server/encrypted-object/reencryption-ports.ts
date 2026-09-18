import type { VaultContext } from '../../lib/domain/identity';
import type { DekVersion } from '../crypto/core';
import type { VaultPartitionRoute } from '../vault-content/records';
import type { EncryptedObjectMetadata } from './core';
import type {
  EncryptedObjectReencryptionInventory,
  EncryptedObjectReencryptionPosition,
} from './reencryption-core';

export type EncryptedObjectReencryptionCommitResult =
  | { readonly kind: 'applied'; readonly metadata: EncryptedObjectMetadata }
  | { readonly kind: 'replayed'; readonly metadata: EncryptedObjectMetadata }
  | { readonly kind: 'conflict'; readonly current?: EncryptedObjectMetadata };

export type EncryptedObjectReencryptionRepository = {
  inventory(
    targetVersion: DekVersion,
  ): Promise<EncryptedObjectReencryptionInventory>;
  listCandidates(input: {
    readonly targetVersion: DekVersion;
    readonly after: EncryptedObjectReencryptionPosition | null;
    readonly limit: number;
  }): Promise<readonly EncryptedObjectMetadata[]>;
  commit(input: {
    readonly expected: EncryptedObjectMetadata;
    readonly replacement: EncryptedObjectMetadata;
    readonly requestedAt: number;
  }): Promise<EncryptedObjectReencryptionCommitResult>;
};

export type EncryptedObjectReencryptionOpenResult =
  | {
      readonly kind: 'opened';
      readonly route: VaultPartitionRoute;
      readonly repository: EncryptedObjectReencryptionRepository;
    }
  | { readonly kind: 'not-found' };

export type EncryptedObjectReencryptionDirectory = {
  open(context: VaultContext): Promise<EncryptedObjectReencryptionOpenResult>;
};
