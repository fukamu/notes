import type { OpaqueObjectKey } from '../encrypted-object/core';
import type { VaultRecoveryBackupPort } from '../encrypted-object/recovery-ports';
import type {
  VaultRecoveryBackupId,
  VaultRecoveryScope,
} from '../encrypted-object/recovery-core';

export class FakeVaultRecoveryBackupError extends Error {
  constructor() {
    super('Fake Vault recovery backup operation failed');
    this.name = 'FakeVaultRecoveryBackupError';
  }
}

export type FakeVaultRecoveryBackup = VaultRecoveryBackupPort & {
  calls(): Readonly<{ manifest: number; ciphertext: number }>;
  failNext(operation: 'manifest' | 'ciphertext'): void;
  replaceForTest(input: {
    readonly backupId: VaultRecoveryBackupId;
    readonly objectKey: OpaqueObjectKey;
    readonly value: unknown;
  }): void;
};

export function createFakeVaultRecoveryBackup(input: {
  readonly manifest: unknown;
  readonly objects: readonly {
    readonly backupId: VaultRecoveryBackupId;
    readonly objectKey: OpaqueObjectKey;
    readonly value: unknown;
  }[];
}): FakeVaultRecoveryBackup {
  const objects = new Map(
    input.objects.map((entry) => [
      storageKey(entry.backupId, entry.objectKey),
      cloneExternalValue(entry.value),
    ]),
  );
  const calls = { manifest: 0, ciphertext: 0 };
  const failures = { manifest: 0, ciphertext: 0 };

  function consumeFailure(operation: keyof typeof failures): void {
    if (failures[operation] === 0) return;
    failures[operation] -= 1;
    throw new FakeVaultRecoveryBackupError();
  }

  return {
    async loadManifest(_scope: VaultRecoveryScope) {
      calls.manifest += 1;
      consumeFailure('manifest');
      return input.manifest;
    },
    async loadCiphertext(request) {
      calls.ciphertext += 1;
      consumeFailure('ciphertext');
      return cloneExternalValue(
        objects.get(storageKey(request.backupId, request.objectKey)),
      );
    },
    calls() {
      return { ...calls };
    },
    failNext(operation) {
      failures[operation] += 1;
    },
    replaceForTest(request) {
      objects.set(
        storageKey(request.backupId, request.objectKey),
        cloneExternalValue(request.value),
      );
    },
  };
}

function storageKey(
  backupId: VaultRecoveryBackupId,
  objectKey: OpaqueObjectKey,
): string {
  return `${backupId}:${objectKey}`;
}

function cloneExternalValue(value: unknown): unknown {
  return value instanceof Uint8Array ? value.slice() : value;
}
