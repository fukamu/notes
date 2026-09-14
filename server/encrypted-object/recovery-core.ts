import {
  arrayDecoder,
  decodeOrThrow,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import { isUuidV7, parseCardId, parseConflictId } from '../../lib/domain/id';
import {
  accountIdDecoder,
  vaultIdDecoder,
  type AccountId,
  type VaultId,
} from '../../lib/domain/identity';
import {
  ENVELOPE_CRYPTO_VERSION,
  cryptoObjectRevisionDecoder,
  dekVersionDecoder,
  vaultDekKeyringDecoder,
  type DekVersion,
  type EnvelopeObject,
  type VaultDekKeyring,
} from '../crypto/core';
import {
  dekRotationOperationDecoder,
  validDekRotationSnapshot,
  type DekRotationOperation,
} from '../crypto/rotation-core';
import {
  encryptedWriteIdDecoder,
  opaqueObjectKeyDecoder,
  storedByteCountDecoder,
  type EncryptedObjectMetadata,
} from './core';
import type {
  EncryptedObjectReencryptionCheckpoint,
  EncryptedObjectReencryptionInventory,
  EncryptedObjectReencryptionPosition,
} from './reencryption-core';

declare const recoveryBackupIdBrand: unique symbol;

export const VAULT_RECOVERY_FORMAT = 'fukamu-vault-recovery/v1';
export const maximumBackupRetentionMs = 30 * 24 * 60 * 60 * 1_000;

export type VaultRecoveryBackupId = string & {
  readonly [recoveryBackupIdBrand]: 'VaultRecoveryBackupId';
};

export type VaultRecoveryScope = {
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
};

export type VaultRecoveryReencryptionState =
  | {
      readonly kind: 'completed';
      readonly targetVersion: DekVersion;
    }
  | {
      readonly kind: 'pending';
      readonly checkpoint: EncryptedObjectReencryptionCheckpoint;
    };

export type VaultRecoveryManifest = VaultRecoveryScope & {
  readonly format: typeof VAULT_RECOVERY_FORMAT;
  readonly backupId: VaultRecoveryBackupId;
  readonly capturedAt: number;
  readonly deleteAfter: number;
  readonly keyring: VaultDekKeyring;
  readonly rotation: DekRotationOperation;
  readonly reencryption: VaultRecoveryReencryptionState;
  readonly objects: readonly EncryptedObjectMetadata[];
};

export type VaultRecoveryDrillReceipt = VaultRecoveryScope & {
  readonly backupId: VaultRecoveryBackupId;
  readonly operationId: DekRotationOperation['operationId'];
  readonly sourceVersion: DekVersion;
  readonly targetVersion: DekVersion;
  readonly capturedAt: number;
  readonly deleteAfter: number;
  readonly drilledAt: number;
  readonly objectCount: number;
  readonly verifiedVersions: readonly DekVersion[];
};

export type VaultRecoveryDrillPlan =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'scope-mismatch'
        | 'invalid-timestamp'
        | 'retention-expired'
        | 'rotation-incomplete'
        | 'incomplete-checkpoint';
    };

export type VaultRecoveryDrillCompletion =
  | { readonly kind: 'verified'; readonly receipt: VaultRecoveryDrillReceipt }
  | { readonly kind: 'invalid-evidence' };

export type VaultBackupRetentionReference = VaultRecoveryScope & {
  readonly backupId: VaultRecoveryBackupId;
  readonly capturedAt: number;
  readonly deleteAfter: number;
  readonly dekVersions: readonly DekVersion[];
  readonly state:
    | { readonly kind: 'retained' }
    | { readonly kind: 'deletion-confirmed'; readonly deletedAt: number };
};

export type VaultKeyRetirementBlockReason =
  | 'scope-mismatch'
  | 'invalid-timestamp'
  | 'rotation-incomplete'
  | 'incomplete-active-inventory'
  | 'active-old-version'
  | 'pending-old-write'
  | 'unexpected-newer-version'
  | 'incomplete-backup-inventory'
  | 'invalid-backup-evidence'
  | 'retained-backup'
  | 'backup-retention-overdue'
  | 'missing-recovery-drill'
  | 'invalid-recovery-drill';

export type VaultKeyRetirementEvaluation =
  | {
      readonly kind: 'blocked';
      readonly reasons: readonly VaultKeyRetirementBlockReason[];
    }
  | {
      readonly kind: 'approval-required';
      readonly accountId: AccountId;
      readonly vaultId: VaultId;
      readonly sourceVersion: DekVersion;
      readonly targetVersion: DekVersion;
      readonly evaluatedAt: number;
      readonly approval: 'explicit-production-key-destruction-approval-required';
    };

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
export const vaultRecoveryBackupIdDecoder: Decoder<VaultRecoveryBackupId> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 128 }),
      (value) => /^[A-Za-z0-9_-]+$/.test(value),
      'expected an opaque backup identifier',
    ),
    (value) => value as VaultRecoveryBackupId,
  );

const envelopeObjectShapeDecoder = objectDecoder({
  kind: unionDecoder(literalDecoder('card'), literalDecoder('conflict')),
  objectId: stringDecoder({ minLength: 36, maxLength: 36 }),
});
const envelopeObjectDecoder: Decoder<EnvelopeObject> = transformDecoder(
  refineDecoder(
    envelopeObjectShapeDecoder,
    (value) => isUuidV7(value.objectId),
    'expected a UUIDv7 object ID',
  ),
  (value): EnvelopeObject =>
    value.kind === 'card'
      ? { kind: 'card', objectId: parseCardId(value.objectId) }
      : { kind: 'conflict', objectId: parseConflictId(value.objectId) },
);
const encryptedObjectMetadataDecoder: Decoder<EncryptedObjectMetadata> =
  objectDecoder({
    object: envelopeObjectDecoder,
    objectRevision: cryptoObjectRevisionDecoder,
    writeId: encryptedWriteIdDecoder,
    objectKey: opaqueObjectKeyDecoder,
    plaintextBytes: storedByteCountDecoder,
    ciphertextBytes: refineDecoder(
      storedByteCountDecoder,
      (value) => value > 0,
      'expected stored ciphertext bytes',
    ),
    cryptoVersion: literalDecoder(ENVELOPE_CRYPTO_VERSION),
    dekVersion: dekVersionDecoder,
    createdAt: timestampDecoder,
  });
const reencryptionPositionDecoder: Decoder<EncryptedObjectReencryptionPosition> =
  objectDecoder({
    object: envelopeObjectDecoder,
    objectRevision: cryptoObjectRevisionDecoder,
  });
const reencryptionCheckpointDecoder: Decoder<EncryptedObjectReencryptionCheckpoint> =
  objectDecoder({
    targetVersion: dekVersionDecoder,
    after: nullableDecoder(reencryptionPositionDecoder),
  });
const reencryptionStateDecoder: Decoder<VaultRecoveryReencryptionState> =
  unionDecoder(
    objectDecoder({
      kind: literalDecoder('completed'),
      targetVersion: dekVersionDecoder,
    }),
    objectDecoder({
      kind: literalDecoder('pending'),
      checkpoint: reencryptionCheckpointDecoder,
    }),
  );
const recoveryManifestShapeDecoder: Decoder<VaultRecoveryManifest> =
  objectDecoder({
    format: literalDecoder(VAULT_RECOVERY_FORMAT),
    backupId: vaultRecoveryBackupIdDecoder,
    accountId: accountIdDecoder,
    vaultId: vaultIdDecoder,
    capturedAt: timestampDecoder,
    deleteAfter: timestampDecoder,
    keyring: vaultDekKeyringDecoder,
    rotation: dekRotationOperationDecoder,
    reencryption: reencryptionStateDecoder,
    objects: arrayDecoder(encryptedObjectMetadataDecoder, {
      maxLength: 30_000,
    }),
  });

export const vaultRecoveryManifestDecoder: Decoder<VaultRecoveryManifest> =
  transformDecoder(
    refineDecoder(
      recoveryManifestShapeDecoder,
      validRecoveryManifest,
      'expected a consistent Vault recovery manifest',
    ),
    (manifest): VaultRecoveryManifest => manifest,
  );

export function parseVaultRecoveryBackupId(
  input: unknown,
): VaultRecoveryBackupId {
  return decodeOrThrow(
    vaultRecoveryBackupIdDecoder,
    input,
    'Vault recovery backup ID',
  );
}

export function decodeVaultRecoveryManifest(
  input: unknown,
): VaultRecoveryManifest {
  return decodeOrThrow(
    vaultRecoveryManifestDecoder,
    input,
    'Vault recovery manifest',
  );
}

export function planVaultRecoveryDrill(input: {
  readonly scope: VaultRecoveryScope;
  readonly manifest: VaultRecoveryManifest;
  readonly drilledAt: number;
}): VaultRecoveryDrillPlan {
  if (
    input.manifest.accountId !== input.scope.accountId ||
    input.manifest.vaultId !== input.scope.vaultId
  ) {
    return { kind: 'blocked', reason: 'scope-mismatch' };
  }
  if (
    !validTimestamp(input.drilledAt) ||
    input.drilledAt < input.manifest.capturedAt
  ) {
    return { kind: 'blocked', reason: 'invalid-timestamp' };
  }
  if (input.drilledAt > input.manifest.deleteAfter) {
    return { kind: 'blocked', reason: 'retention-expired' };
  }
  if (input.manifest.rotation.state.kind !== 'completed') {
    return { kind: 'blocked', reason: 'rotation-incomplete' };
  }
  if (input.manifest.reencryption.kind !== 'completed') {
    return { kind: 'blocked', reason: 'incomplete-checkpoint' };
  }
  return { kind: 'accepted' };
}

export function completeVaultRecoveryDrill(input: {
  readonly manifest: VaultRecoveryManifest;
  readonly drilledAt: number;
  readonly verifiedObjects: number;
  readonly verifiedVersions: readonly DekVersion[];
}): VaultRecoveryDrillCompletion {
  const plan = planVaultRecoveryDrill({
    scope: {
      accountId: input.manifest.accountId,
      vaultId: input.manifest.vaultId,
    },
    manifest: input.manifest,
    drilledAt: input.drilledAt,
  });
  const expectedVersions = uniqueSortedVersions(
    input.manifest.objects.map((object) => object.dekVersion),
  );
  const actualVersions = uniqueSortedVersions(input.verifiedVersions);
  if (
    plan.kind !== 'accepted' ||
    input.manifest.rotation.state.kind !== 'completed' ||
    input.manifest.reencryption.kind !== 'completed' ||
    input.verifiedObjects !== input.manifest.objects.length ||
    !sameVersions(expectedVersions, actualVersions)
  ) {
    return { kind: 'invalid-evidence' };
  }
  return {
    kind: 'verified',
    receipt: {
      backupId: input.manifest.backupId,
      accountId: input.manifest.accountId,
      vaultId: input.manifest.vaultId,
      operationId: input.manifest.rotation.operationId,
      sourceVersion: input.manifest.rotation.sourceVersion,
      targetVersion: input.manifest.rotation.targetVersion,
      capturedAt: input.manifest.capturedAt,
      deleteAfter: input.manifest.deleteAfter,
      drilledAt: input.drilledAt,
      objectCount: input.verifiedObjects,
      verifiedVersions: expectedVersions,
    },
  };
}

export function evaluateVaultKeyRetirement(input: {
  readonly scope: VaultRecoveryScope;
  readonly rotation: DekRotationOperation;
  readonly activeInventory: EncryptedObjectReencryptionInventory;
  readonly backupInventoryComplete: boolean;
  readonly backups: readonly VaultBackupRetentionReference[];
  readonly drillReceipt?: VaultRecoveryDrillReceipt;
  readonly evaluatedAt: number;
}): VaultKeyRetirementEvaluation {
  const reasons = new Set<VaultKeyRetirementBlockReason>();
  if (
    input.rotation.accountId !== input.scope.accountId ||
    input.rotation.vaultId !== input.scope.vaultId
  ) {
    reasons.add('scope-mismatch');
  }
  if (
    !validTimestamp(input.evaluatedAt) ||
    input.evaluatedAt < input.rotation.updatedAt
  ) {
    reasons.add('invalid-timestamp');
  }
  if (input.rotation.state.kind !== 'completed') {
    reasons.add('rotation-incomplete');
  }
  evaluateActiveInventory(input.activeInventory, reasons);
  evaluateBackups(input, reasons);
  evaluateDrillReceipt(input, reasons);
  if (reasons.size > 0 || input.rotation.state.kind !== 'completed') {
    return { kind: 'blocked', reasons: [...reasons].sort() };
  }
  return {
    kind: 'approval-required',
    accountId: input.scope.accountId,
    vaultId: input.scope.vaultId,
    sourceVersion: input.rotation.sourceVersion,
    targetVersion: input.rotation.targetVersion,
    evaluatedAt: input.evaluatedAt,
    approval: 'explicit-production-key-destruction-approval-required',
  };
}

function validRecoveryManifest(manifest: VaultRecoveryManifest): boolean {
  const positionTarget =
    manifest.reencryption.kind === 'completed'
      ? manifest.reencryption.targetVersion
      : manifest.reencryption.checkpoint.targetVersion;
  if (
    manifest.keyring.vaultId !== manifest.vaultId ||
    manifest.rotation.accountId !== manifest.accountId ||
    manifest.rotation.vaultId !== manifest.vaultId ||
    !validDekRotationSnapshot({
      keyring: manifest.keyring,
      operation: manifest.rotation,
    }) ||
    positionTarget !== manifest.rotation.targetVersion ||
    manifest.capturedAt < manifest.rotation.updatedAt ||
    manifest.deleteAfter < manifest.capturedAt ||
    manifest.deleteAfter - manifest.capturedAt > maximumBackupRetentionMs
  ) {
    return false;
  }
  if (
    manifest.reencryption.kind === 'completed' &&
    manifest.rotation.state.kind !== 'completed'
  ) {
    return false;
  }
  const identities = new Set<string>();
  const objectKeys = new Set<string>();
  const availableVersions = new Set(
    manifest.keyring.versions.map((metadata) => metadata.dekVersion),
  );
  for (const metadata of manifest.objects) {
    const identity = `${metadata.object.kind}:${metadata.object.objectId}:${metadata.objectRevision}`;
    if (
      identities.has(identity) ||
      objectKeys.has(metadata.objectKey) ||
      !availableVersions.has(metadata.dekVersion)
    ) {
      return false;
    }
    identities.add(identity);
    objectKeys.add(metadata.objectKey);
  }
  return true;
}

function evaluateActiveInventory(
  inventory: EncryptedObjectReencryptionInventory,
  reasons: Set<VaultKeyRetirementBlockReason>,
): void {
  const counts = [
    inventory.olderObjects,
    inventory.targetObjects,
    inventory.newerObjects,
    inventory.olderWriteIntents,
    inventory.newerWriteIntents,
  ];
  if (!inventory.routePresent || counts.some((count) => !validCount(count))) {
    reasons.add('incomplete-active-inventory');
    return;
  }
  if (inventory.olderObjects > 0) reasons.add('active-old-version');
  if (inventory.olderWriteIntents > 0) reasons.add('pending-old-write');
  if (inventory.newerObjects > 0 || inventory.newerWriteIntents > 0) {
    reasons.add('unexpected-newer-version');
  }
}

function evaluateBackups(
  input: {
    readonly scope: VaultRecoveryScope;
    readonly rotation: DekRotationOperation;
    readonly backupInventoryComplete: boolean;
    readonly backups: readonly VaultBackupRetentionReference[];
    readonly evaluatedAt: number;
  },
  reasons: Set<VaultKeyRetirementBlockReason>,
): void {
  if (!input.backupInventoryComplete) {
    reasons.add('incomplete-backup-inventory');
  }
  const seen = new Set<VaultRecoveryBackupId>();
  for (const backup of input.backups) {
    if (
      seen.has(backup.backupId) ||
      backup.accountId !== input.scope.accountId ||
      backup.vaultId !== input.scope.vaultId ||
      !validRetentionReference(backup)
    ) {
      reasons.add('invalid-backup-evidence');
      continue;
    }
    seen.add(backup.backupId);
    if (
      backup.state.kind === 'retained' &&
      backup.dekVersions.includes(input.rotation.sourceVersion)
    ) {
      reasons.add(
        input.evaluatedAt > backup.deleteAfter
          ? 'backup-retention-overdue'
          : 'retained-backup',
      );
    }
  }
}

function evaluateDrillReceipt(
  input: {
    readonly scope: VaultRecoveryScope;
    readonly rotation: DekRotationOperation;
    readonly drillReceipt?: VaultRecoveryDrillReceipt;
    readonly evaluatedAt: number;
  },
  reasons: Set<VaultKeyRetirementBlockReason>,
): void {
  const receipt = input.drillReceipt;
  if (receipt === undefined) {
    reasons.add('missing-recovery-drill');
    return;
  }
  const completedAt =
    input.rotation.state.kind === 'completed'
      ? input.rotation.state.completedAt
      : Number.MAX_SAFE_INTEGER;
  if (
    receipt.accountId !== input.scope.accountId ||
    receipt.vaultId !== input.scope.vaultId ||
    receipt.operationId !== input.rotation.operationId ||
    receipt.sourceVersion !== input.rotation.sourceVersion ||
    receipt.targetVersion !== input.rotation.targetVersion ||
    !validDrillReceipt(receipt) ||
    receipt.drilledAt < completedAt ||
    receipt.drilledAt > input.evaluatedAt ||
    !receipt.verifiedVersions.includes(input.rotation.sourceVersion) ||
    !receipt.verifiedVersions.includes(input.rotation.targetVersion)
  ) {
    reasons.add('invalid-recovery-drill');
  }
}

function validRetentionReference(
  backup: VaultBackupRetentionReference,
): boolean {
  if (
    !validTimestamp(backup.capturedAt) ||
    !validTimestamp(backup.deleteAfter) ||
    backup.deleteAfter < backup.capturedAt ||
    backup.deleteAfter - backup.capturedAt > maximumBackupRetentionMs ||
    new Set(backup.dekVersions).size !== backup.dekVersions.length
  ) {
    return false;
  }
  return (
    backup.state.kind === 'retained' ||
    (validTimestamp(backup.state.deletedAt) &&
      backup.state.deletedAt >= backup.capturedAt &&
      backup.state.deletedAt <= backup.deleteAfter)
  );
}

function validDrillReceipt(receipt: VaultRecoveryDrillReceipt): boolean {
  return (
    validTimestamp(receipt.capturedAt) &&
    validTimestamp(receipt.deleteAfter) &&
    validTimestamp(receipt.drilledAt) &&
    receipt.capturedAt <= receipt.drilledAt &&
    receipt.drilledAt <= receipt.deleteAfter &&
    receipt.deleteAfter - receipt.capturedAt <= maximumBackupRetentionMs &&
    validCount(receipt.objectCount) &&
    new Set(receipt.verifiedVersions).size === receipt.verifiedVersions.length
  );
}

function uniqueSortedVersions(versions: readonly DekVersion[]): DekVersion[] {
  return [...new Set(versions)].sort((left, right) => left - right);
}

function sameVersions(
  left: readonly DekVersion[],
  right: readonly DekVersion[],
): boolean {
  return (
    left.length === right.length &&
    left.every((version, index) => version === right[index])
  );
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
