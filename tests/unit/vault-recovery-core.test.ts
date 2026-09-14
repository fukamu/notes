import { describe, expect, it } from 'vitest';
import {
  completeVaultRecoveryDrill,
  decodeVaultRecoveryManifest,
  evaluateVaultKeyRetirement,
  maximumBackupRetentionMs,
  planVaultRecoveryDrill,
  VAULT_RECOVERY_FORMAT,
  type VaultBackupRetentionReference,
  type VaultRecoveryDrillReceipt,
} from '@/server/encrypted-object/recovery-core';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import {
  envelopeCryptoIds,
  envelopeKeyring,
} from '@/tests/fixtures/envelope-crypto';
import { encryptedObjectMetadata } from '@/tests/fixtures/encrypted-object';
import {
  completedRecoveryRotation,
  vaultRecoveryIds,
} from '@/tests/fixtures/vault-recovery';

const scope = {
  accountId: controlPlaneIds.accountA,
  vaultId: controlPlaneIds.vaultA,
};

describe('Vault recovery and key retirement core', () => {
  it('decodes a 30-day bounded mixed-version manifest and issues a content-free receipt', () => {
    const manifest = decodeVaultRecoveryManifest(recoveryManifest());
    expect(manifest.objects.map((object) => object.dekVersion)).toEqual([
      envelopeCryptoIds.dekVersion1,
      envelopeCryptoIds.dekVersion2,
    ]);
    expect(
      planVaultRecoveryDrill({ scope, manifest, drilledAt: 3_000 }),
    ).toEqual({ kind: 'accepted' });
    const completion = completeVaultRecoveryDrill({
      manifest,
      drilledAt: 3_000,
      verifiedObjects: 2,
      verifiedVersions: [
        envelopeCryptoIds.dekVersion2,
        envelopeCryptoIds.dekVersion1,
      ],
    });
    expect(completion).toMatchObject({ kind: 'verified' });
    if (completion.kind !== 'verified') throw new Error('missing receipt');
    expect(completion.receipt).toMatchObject({
      backupId: vaultRecoveryIds.backupA,
      objectCount: 2,
      verifiedVersions: [
        envelopeCryptoIds.dekVersion1,
        envelopeCryptoIds.dekVersion2,
      ],
    });
    expect(() =>
      decodeVaultRecoveryManifest({
        ...recoveryManifest(),
        deleteAfter: 2_200 + maximumBackupRetentionMs + 1,
      }),
    ).toThrow();
  });

  it('fails closed before object access for incomplete checkpoints, wrong scope, and expired retention', () => {
    const pending = decodeVaultRecoveryManifest({
      ...recoveryManifest(),
      reencryption: {
        kind: 'pending',
        checkpoint: {
          targetVersion: envelopeCryptoIds.dekVersion2,
          after: null,
        },
      },
    });
    expect(
      planVaultRecoveryDrill({ scope, manifest: pending, drilledAt: 3_000 }),
    ).toEqual({ kind: 'blocked', reason: 'incomplete-checkpoint' });
    expect(
      planVaultRecoveryDrill({
        scope: {
          accountId: controlPlaneIds.accountB,
          vaultId: controlPlaneIds.vaultB,
        },
        manifest: decodeVaultRecoveryManifest(recoveryManifest()),
        drilledAt: 3_000,
      }),
    ).toEqual({ kind: 'blocked', reason: 'scope-mismatch' });
    expect(
      planVaultRecoveryDrill({
        scope,
        manifest: decodeVaultRecoveryManifest(recoveryManifest()),
        drilledAt: 2_200 + maximumBackupRetentionMs + 1,
      }),
    ).toEqual({ kind: 'blocked', reason: 'retention-expired' });
    expect(
      completeVaultRecoveryDrill({
        manifest: decodeVaultRecoveryManifest(recoveryManifest()),
        drilledAt: 3_000,
        verifiedObjects: 1,
        verifiedVersions: [envelopeCryptoIds.dekVersion1],
      }),
    ).toEqual({ kind: 'invalid-evidence' });
  });

  it('never authorizes deletion and stops at an explicit approval gate', () => {
    const manifest = decodeVaultRecoveryManifest(recoveryManifest());
    const completion = completeVaultRecoveryDrill({
      manifest,
      drilledAt: 3_000,
      verifiedObjects: 2,
      verifiedVersions: [
        envelopeCryptoIds.dekVersion1,
        envelopeCryptoIds.dekVersion2,
      ],
    });
    if (completion.kind !== 'verified') throw new Error('missing receipt');
    const result = evaluateVaultKeyRetirement({
      scope,
      rotation: completedRecoveryRotation(),
      activeInventory: cleanInventory(),
      backupInventoryComplete: true,
      backups: [deletedBackupReference()],
      drillReceipt: completion.receipt,
      evaluatedAt: 4_000,
    });
    expect(result).toEqual({
      kind: 'approval-required',
      accountId: scope.accountId,
      vaultId: scope.vaultId,
      sourceVersion: envelopeCryptoIds.dekVersion1,
      targetVersion: envelopeCryptoIds.dekVersion2,
      evaluatedAt: 4_000,
      approval: 'explicit-production-key-destruction-approval-required',
    });
    expect(result.kind).not.toBe('ready');
  });

  it('blocks on active data, pending writes, retained backups, incomplete inventory, or invalid drill evidence', () => {
    const receipt = verifiedReceipt();
    expect(
      blockedReasons({
        inventory: { ...cleanInventory(), olderObjects: 1 },
        receipt,
      }),
    ).toContain('active-old-version');
    expect(
      blockedReasons({
        inventory: { ...cleanInventory(), olderWriteIntents: 1 },
        receipt,
      }),
    ).toContain('pending-old-write');
    expect(
      blockedReasons({
        inventory: { ...cleanInventory(), newerObjects: 1 },
        receipt,
      }),
    ).toContain('unexpected-newer-version');
    expect(blockedReasons({ complete: false, receipt })).toContain(
      'incomplete-backup-inventory',
    );
    expect(
      blockedReasons({
        backups: [
          {
            ...deletedBackupReference(),
            deleteAfter: 5_000,
            state: { kind: 'retained' },
          },
        ],
        receipt,
      }),
    ).toContain('retained-backup');
    expect(
      blockedReasons({
        backups: [{ ...deletedBackupReference(), state: { kind: 'retained' } }],
        receipt,
      }),
    ).toContain('backup-retention-overdue');
    expect(
      blockedReasons({
        backups: [
          {
            ...deletedBackupReference(),
            state: { kind: 'deletion-confirmed', deletedAt: 3_001 },
          },
        ],
        receipt,
      }),
    ).toContain('invalid-backup-evidence');
    expect(blockedReasons({})).toContain('missing-recovery-drill');
    expect(
      blockedReasons({
        receipt: { ...receipt, sourceVersion: envelopeCryptoIds.dekVersion2 },
      }),
    ).toContain('invalid-recovery-drill');
    const futureReceiptReasons = blockedReasons({
      receipt,
      evaluatedAt: 2_000,
    });
    expect(futureReceiptReasons).toContain('invalid-timestamp');
    expect(futureReceiptReasons).toContain('invalid-recovery-drill');
  });
});

function recoveryManifest() {
  return {
    format: VAULT_RECOVERY_FORMAT,
    backupId: vaultRecoveryIds.backupA,
    ...scope,
    capturedAt: 2_200,
    deleteAfter: 2_200 + maximumBackupRetentionMs,
    keyring: envelopeKeyring(2),
    rotation: completedRecoveryRotation(),
    reencryption: {
      kind: 'completed',
      targetVersion: envelopeCryptoIds.dekVersion2,
    },
    objects: [
      encryptedObjectMetadata(),
      {
        ...encryptedObjectMetadata({ card: 'b', write: 'b', key: 'b' }),
        dekVersion: envelopeCryptoIds.dekVersion2,
      },
    ],
  };
}

function cleanInventory() {
  return {
    routePresent: true,
    olderObjects: 0,
    targetObjects: 2,
    newerObjects: 0,
    olderWriteIntents: 0,
    newerWriteIntents: 0,
  };
}

function deletedBackupReference(): VaultBackupRetentionReference {
  return {
    backupId: vaultRecoveryIds.backupA,
    ...scope,
    capturedAt: 2_200,
    deleteAfter: 3_000,
    dekVersions: [envelopeCryptoIds.dekVersion1, envelopeCryptoIds.dekVersion2],
    state: { kind: 'deletion-confirmed', deletedAt: 3_000 },
  };
}

function verifiedReceipt(): VaultRecoveryDrillReceipt {
  const completion = completeVaultRecoveryDrill({
    manifest: decodeVaultRecoveryManifest(recoveryManifest()),
    drilledAt: 3_000,
    verifiedObjects: 2,
    verifiedVersions: [
      envelopeCryptoIds.dekVersion1,
      envelopeCryptoIds.dekVersion2,
    ],
  });
  if (completion.kind !== 'verified') throw new Error('missing receipt');
  return completion.receipt;
}

function blockedReasons(input: {
  readonly inventory?: ReturnType<typeof cleanInventory>;
  readonly complete?: boolean;
  readonly backups?: readonly VaultBackupRetentionReference[];
  readonly receipt?: VaultRecoveryDrillReceipt;
  readonly evaluatedAt?: number;
}) {
  const result = evaluateVaultKeyRetirement({
    scope,
    rotation: completedRecoveryRotation(),
    activeInventory: input.inventory ?? cleanInventory(),
    backupInventoryComplete: input.complete ?? true,
    backups: input.backups ?? [deletedBackupReference()],
    ...(input.receipt === undefined ? {} : { drillReceipt: input.receipt }),
    evaluatedAt: input.evaluatedAt ?? 4_000,
  });
  if (result.kind !== 'blocked') throw new Error('expected retirement block');
  return result.reasons;
}
