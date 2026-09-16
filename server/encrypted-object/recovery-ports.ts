import type { OpaqueObjectKey } from './core';
import type {
  VaultRecoveryBackupId,
  VaultRecoveryScope,
} from './recovery-core';

export type VaultRecoveryBackupPort = {
  loadManifest(scope: VaultRecoveryScope): Promise<unknown>;
  loadCiphertext(input: {
    readonly backupId: VaultRecoveryBackupId;
    readonly objectKey: OpaqueObjectKey;
  }): Promise<unknown>;
};
