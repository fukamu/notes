import type { VaultContext } from '../../lib/domain/identity';
import type {
  CardCompareAndSwap,
  PartitionAssignment,
  PartitionCompareAndSwap,
  VaultLiveDataPurgeResult,
} from './public';
import type { VaultCardIndexRecord, VaultPartitionRoute } from './records';
import { parseRoutingRevision } from './records';

export type VaultOwner = Pick<VaultContext, 'accountId' | 'vaultId'>;

export type PartitionAssignmentPlan =
  | { readonly kind: 'accepted'; readonly route: VaultPartitionRoute }
  | { readonly kind: 'rejected'; readonly reason: 'owner-mismatch' };

export type PartitionCompareAndSwapPlan =
  | { readonly kind: 'accepted'; readonly route: VaultPartitionRoute }
  | {
      readonly kind: 'rejected';
      readonly reason: 'stale-revision' | 'invalid-timeline' | 'no-change';
    };

export type CardCompareAndSwapPlan =
  | {
      readonly kind: 'accepted';
      readonly operation: 'insert' | 'update';
      readonly record: VaultCardIndexRecord;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'unexpected-existing-record'
        | 'missing-record'
        | 'stale-revision'
        | 'invalid-next-revision'
        | 'invalid-timeline';
    };

export function evaluateVaultLiveDataPurge(input: {
  readonly ownerMatches: boolean;
  readonly routePresentBefore: boolean;
  readonly remaining: {
    readonly routes: number;
    readonly cards: number;
    readonly mutationReceipts: number;
    readonly conflicts: number;
    readonly syncStates: number;
    readonly displayIds: number;
    readonly syncCommits: number;
    readonly syncChanges: number;
    readonly encryptedObjects: number;
    readonly encryptedWriteIntents: number;
  };
}): VaultLiveDataPurgeResult {
  if (!input.ownerMatches) {
    return { kind: 'terminal-failure', reason: 'owner-mismatch' };
  }
  const counts = Object.values(input.remaining);
  if (
    counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
    input.remaining.routes > 1
  ) {
    return { kind: 'retryable-failure', reason: 'incomplete-delete' };
  }
  if (
    input.remaining.encryptedObjects !== 0 ||
    input.remaining.encryptedWriteIntents !== 0
  ) {
    return {
      kind: 'retryable-failure',
      reason: 'object-inventory-not-empty',
    };
  }
  if (Object.values(input.remaining).some((count) => count !== 0)) {
    return { kind: 'retryable-failure', reason: 'incomplete-delete' };
  }
  return {
    kind: 'confirmed',
    outcome: input.routePresentBefore ? 'purged' : 'already-purged',
  };
}

export function planPartitionAssignment(
  context: VaultContext,
  owner: VaultOwner | undefined,
  assignment: PartitionAssignment,
): PartitionAssignmentPlan {
  if (
    owner === undefined ||
    owner.accountId !== context.accountId ||
    owner.vaultId !== context.vaultId
  ) {
    return { kind: 'rejected', reason: 'owner-mismatch' };
  }
  return {
    kind: 'accepted',
    route: {
      partitionId: assignment.partitionId,
      routingRevision: parseRoutingRevision(1),
      updatedAt: assignment.updatedAt,
    },
  };
}

export function planPartitionCompareAndSwap(
  current: VaultPartitionRoute,
  command: PartitionCompareAndSwap,
): PartitionCompareAndSwapPlan {
  if (current.routingRevision !== command.expectedRoutingRevision) {
    return { kind: 'rejected', reason: 'stale-revision' };
  }
  if (current.partitionId === command.nextPartitionId) {
    return { kind: 'rejected', reason: 'no-change' };
  }
  if (command.updatedAt < current.updatedAt) {
    return { kind: 'rejected', reason: 'invalid-timeline' };
  }
  if (current.routingRevision === 2_147_483_647) {
    return { kind: 'rejected', reason: 'stale-revision' };
  }
  return {
    kind: 'accepted',
    route: {
      partitionId: command.nextPartitionId,
      routingRevision: parseRoutingRevision(current.routingRevision + 1),
      updatedAt: command.updatedAt,
    },
  };
}

export function planCardCompareAndSwap(
  current: VaultCardIndexRecord | undefined,
  command: CardCompareAndSwap,
): CardCompareAndSwapPlan {
  if (current === undefined) {
    if (command.expectedRevision !== null) {
      return { kind: 'rejected', reason: 'missing-record' };
    }
    if (command.nextRevision !== 1) {
      return { kind: 'rejected', reason: 'invalid-next-revision' };
    }
    return {
      kind: 'accepted',
      operation: 'insert',
      record: {
        cardId: command.cardId,
        revision: command.nextRevision,
        updatedAt: command.updatedAt,
      },
    };
  }
  if (command.expectedRevision === null) {
    return { kind: 'rejected', reason: 'unexpected-existing-record' };
  }
  if (current.revision !== command.expectedRevision) {
    return { kind: 'rejected', reason: 'stale-revision' };
  }
  if (command.nextRevision !== current.revision + 1) {
    return { kind: 'rejected', reason: 'invalid-next-revision' };
  }
  if (command.updatedAt < current.updatedAt) {
    return { kind: 'rejected', reason: 'invalid-timeline' };
  }
  return {
    kind: 'accepted',
    operation: 'update',
    record: {
      cardId: command.cardId,
      revision: command.nextRevision,
      updatedAt: command.updatedAt,
    },
  };
}
