import type { EnvelopeEncryptionService } from '../crypto/envelope-service';
import { planStoredCiphertext } from './core';
import {
  completeVaultRecoveryDrill,
  decodeVaultRecoveryManifest,
  planVaultRecoveryDrill,
  type VaultRecoveryDrillReceipt,
  type VaultRecoveryScope,
} from './recovery-core';
import type { VaultRecoveryBackupPort } from './recovery-ports';
import { decodeEncryptedObjectCiphertext } from './service';

export type VaultRecoveryDrillResult =
  | { readonly kind: 'verified'; readonly receipt: VaultRecoveryDrillReceipt }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'invalid-manifest'
        | 'backup-unavailable'
        | 'scope-mismatch'
        | 'invalid-timestamp'
        | 'retention-expired'
        | 'rotation-incomplete'
        | 'incomplete-checkpoint'
        | 'missing-object'
        | 'invalid-ciphertext'
        | 'authentication-failed'
        | 'invalid-evidence';
    };

export type VaultRecoveryDrillService = {
  run(input: {
    readonly scope: VaultRecoveryScope;
    readonly drilledAt: number;
  }): Promise<VaultRecoveryDrillResult>;
};

export function createVaultRecoveryDrillService(input: {
  readonly backup: VaultRecoveryBackupPort;
  readonly encryption: EnvelopeEncryptionService;
}): VaultRecoveryDrillService {
  return {
    async run(command) {
      let rawManifest: unknown;
      try {
        rawManifest = await input.backup.loadManifest(command.scope);
      } catch {
        return { kind: 'blocked', reason: 'backup-unavailable' };
      }
      let manifest;
      try {
        manifest = decodeVaultRecoveryManifest(rawManifest);
      } catch {
        return { kind: 'blocked', reason: 'invalid-manifest' };
      }
      const plan = planVaultRecoveryDrill({
        scope: command.scope,
        manifest,
        drilledAt: command.drilledAt,
      });
      if (plan.kind === 'blocked') return plan;

      const verifiedVersions = [];
      let verifiedObjects = 0;
      for (const metadata of manifest.objects) {
        let rawCiphertext: unknown;
        try {
          rawCiphertext = await input.backup.loadCiphertext({
            backupId: manifest.backupId,
            objectKey: metadata.objectKey,
          });
        } catch {
          return { kind: 'blocked', reason: 'backup-unavailable' };
        }
        if (rawCiphertext === undefined) {
          return { kind: 'blocked', reason: 'missing-object' };
        }
        if (!(rawCiphertext instanceof Uint8Array)) {
          return { kind: 'blocked', reason: 'invalid-ciphertext' };
        }
        let ciphertext;
        try {
          ciphertext = decodeEncryptedObjectCiphertext(rawCiphertext);
        } catch {
          return { kind: 'blocked', reason: 'invalid-ciphertext' };
        }
        const storedPlan = planStoredCiphertext({
          metadata,
          ciphertext,
          actualCiphertextBytes: rawCiphertext.byteLength,
        });
        if (storedPlan.kind === 'rejected') {
          return { kind: 'blocked', reason: 'invalid-ciphertext' };
        }
        let plaintext: Uint8Array;
        try {
          plaintext = await input.encryption.decrypt({
            keyring: manifest.keyring,
            context: {
              vaultId: manifest.vaultId,
              object: metadata.object,
              objectRevision: metadata.objectRevision,
            },
            ciphertext,
          });
        } catch {
          return { kind: 'blocked', reason: 'authentication-failed' };
        }
        const plaintextBytes = plaintext.byteLength;
        plaintext.fill(0);
        if (plaintextBytes !== metadata.plaintextBytes) {
          return { kind: 'blocked', reason: 'invalid-ciphertext' };
        }
        verifiedObjects += 1;
        verifiedVersions.push(metadata.dekVersion);
      }

      const completion = completeVaultRecoveryDrill({
        manifest,
        drilledAt: command.drilledAt,
        verifiedObjects,
        verifiedVersions,
      });
      return completion.kind === 'verified'
        ? completion
        : { kind: 'blocked', reason: 'invalid-evidence' };
    },
  };
}
