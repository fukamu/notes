import { parseSessionId, type VaultContext } from '@/lib/domain/identity';
import {
  parseContentRevision,
  parsePartitionId,
  parseRoutingRevision,
} from '@/server/vault-content/records';
import {
  controlPlaneContext,
  controlPlaneIds,
} from '@/tests/fixtures/control-plane';
import {
  fixtureCardId,
  fixtureConflictId,
  fixtureMutationId,
} from '@/tests/fixtures/ids';

export const vaultContentIds = {
  card: fixtureCardId('vault-content-shared'),
  conflict: fixtureConflictId('vault-content-shared'),
  mutation: fixtureMutationId('vault-content-shared'),
  partitionHot: parsePartitionId('partition-hot'),
  partitionRemapped: parsePartitionId('partition-remapped'),
  revision1: parseContentRevision(1),
  revision2: parseContentRevision(2),
  routingRevision1: parseRoutingRevision(1),
  routingRevision2: parseRoutingRevision(2),
  sessionB: parseSessionId('01991f20-61d2-7000-8000-000000001402'),
} as const;

export function vaultContentContext(account: 'a' | 'b'): VaultContext {
  if (account === 'a') return controlPlaneContext();
  return {
    accountId: controlPlaneIds.accountB,
    vaultId: controlPlaneIds.vaultB,
    sessionId: vaultContentIds.sessionB,
    sessionEpoch: controlPlaneIds.epoch,
  };
}
