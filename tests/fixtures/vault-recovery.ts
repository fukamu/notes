import {
  parseDekRotationOperationId,
  planDekRotationGenerated,
  planDekRotationPromotion,
  planDekRotationStart,
} from '@/server/crypto/rotation-core';
import { parseVaultRecoveryBackupId } from '@/server/encrypted-object/recovery-core';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import {
  envelopeDekMetadata,
  envelopeKeyring,
} from '@/tests/fixtures/envelope-crypto';

export const vaultRecoveryIds = {
  backupA: parseVaultRecoveryBackupId('backup_fixture_a'),
  backupB: parseVaultRecoveryBackupId('backup_fixture_b'),
  operation: parseDekRotationOperationId(
    '01991f20-61d2-7000-8000-000000001901',
  ),
} as const;

export function completedRecoveryRotation() {
  const scope = {
    accountId: controlPlaneIds.accountA,
    vaultId: controlPlaneIds.vaultA,
  };
  const started = planDekRotationStart({
    scope,
    keyring: envelopeKeyring(),
    operationId: vaultRecoveryIds.operation,
    requestedAt: 1_500,
  });
  if (started.kind !== 'accepted') throw new Error('rotation start rejected');
  const generated = planDekRotationGenerated({
    operation: started.next,
    metadata: envelopeDekMetadata(2),
    generatedAt: 2_000,
  });
  if (generated.kind !== 'accepted') {
    throw new Error('rotation generation rejected');
  }
  const promoted = planDekRotationPromotion({
    operation: generated.transition.next,
    keyring: envelopeKeyring(),
    completedAt: 2_100,
  });
  if (promoted.kind !== 'accepted') {
    throw new Error('rotation promotion rejected');
  }
  return promoted.transition.next;
}
