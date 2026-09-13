import { describe, expect, it } from 'vitest';
import {
  evaluateVaultLiveDataPurge,
  planCardCompareAndSwap,
  planPartitionAssignment,
  planPartitionCompareAndSwap,
} from '@/server/vault-content/core';
import {
  controlPlaneIds,
  controlPlaneContext,
} from '@/tests/fixtures/control-plane';
import {
  vaultContentContext,
  vaultContentIds,
} from '@/tests/fixtures/vault-content';

describe('Vault content routing and CAS plans', () => {
  it('derives a first route only from the authenticated Vault owner', () => {
    const context = controlPlaneContext();
    const assignment = {
      partitionId: vaultContentIds.partitionHot,
      updatedAt: 1_000,
    };
    expect(
      planPartitionAssignment(
        context,
        { accountId: context.accountId, vaultId: context.vaultId },
        assignment,
      ),
    ).toEqual({
      kind: 'accepted',
      route: {
        partitionId: vaultContentIds.partitionHot,
        routingRevision: vaultContentIds.routingRevision1,
        updatedAt: 1_000,
      },
    });
    expect(
      planPartitionAssignment(
        context,
        {
          accountId: controlPlaneIds.accountB,
          vaultId: controlPlaneIds.vaultB,
        },
        assignment,
      ),
    ).toEqual({ kind: 'rejected', reason: 'owner-mismatch' });
  });

  it('uses routing revision and timeline as the remap CAS contract', () => {
    const current = {
      partitionId: vaultContentIds.partitionHot,
      routingRevision: vaultContentIds.routingRevision1,
      updatedAt: 1_000,
    };
    expect(
      planPartitionCompareAndSwap(current, {
        expectedRoutingRevision: vaultContentIds.routingRevision1,
        nextPartitionId: vaultContentIds.partitionRemapped,
        updatedAt: 2_000,
      }),
    ).toEqual({
      kind: 'accepted',
      route: {
        partitionId: vaultContentIds.partitionRemapped,
        routingRevision: vaultContentIds.routingRevision2,
        updatedAt: 2_000,
      },
    });
    expect(
      planPartitionCompareAndSwap(current, {
        expectedRoutingRevision: vaultContentIds.routingRevision2,
        nextPartitionId: vaultContentIds.partitionRemapped,
        updatedAt: 2_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale-revision' });
    expect(
      planPartitionCompareAndSwap(current, {
        expectedRoutingRevision: vaultContentIds.routingRevision1,
        nextPartitionId: vaultContentIds.partitionRemapped,
        updatedAt: 999,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-timeline' });
  });

  it('plans create and update CAS without accepting a stale revision', () => {
    const create = {
      cardId: vaultContentIds.card,
      expectedRevision: null,
      nextRevision: vaultContentIds.revision1,
      updatedAt: 1_000,
    } as const;
    expect(planCardCompareAndSwap(undefined, create)).toMatchObject({
      kind: 'accepted',
      operation: 'insert',
    });
    const current = {
      cardId: vaultContentIds.card,
      revision: vaultContentIds.revision1,
      updatedAt: 1_000,
    };
    expect(
      planCardCompareAndSwap(current, {
        ...create,
        expectedRevision: vaultContentIds.revision1,
        nextRevision: vaultContentIds.revision2,
        updatedAt: 2_000,
      }),
    ).toMatchObject({ kind: 'accepted', operation: 'update' });
    expect(
      planCardCompareAndSwap(current, {
        ...create,
        expectedRevision: vaultContentIds.revision2,
        nextRevision: vaultContentIds.revision2,
      }),
    ).toEqual({ kind: 'rejected', reason: 'stale-revision' });

    expect(vaultContentContext('a').vaultId).toBe(controlPlaneIds.vaultA);
  });

  it('confirms live purge only for the owner with no remaining scoped rows', () => {
    expect(
      evaluateVaultLiveDataPurge({
        ownerMatches: true,
        routePresentBefore: true,
        remaining: emptyCounts(),
      }),
    ).toEqual({ kind: 'confirmed', outcome: 'purged' });
    expect(
      evaluateVaultLiveDataPurge({
        ownerMatches: true,
        routePresentBefore: false,
        remaining: emptyCounts(),
      }),
    ).toEqual({ kind: 'confirmed', outcome: 'already-purged' });
    expect(
      evaluateVaultLiveDataPurge({
        ownerMatches: false,
        routePresentBefore: false,
        remaining: emptyCounts(),
      }),
    ).toEqual({ kind: 'terminal-failure', reason: 'owner-mismatch' });
    expect(
      evaluateVaultLiveDataPurge({
        ownerMatches: true,
        routePresentBefore: true,
        remaining: { ...emptyCounts(), encryptedObjects: 1 },
      }),
    ).toEqual({
      kind: 'retryable-failure',
      reason: 'object-inventory-not-empty',
    });
    expect(
      evaluateVaultLiveDataPurge({
        ownerMatches: true,
        routePresentBefore: true,
        remaining: { ...emptyCounts(), syncChanges: 1 },
      }),
    ).toEqual({ kind: 'retryable-failure', reason: 'incomplete-delete' });
    expect(
      evaluateVaultLiveDataPurge({
        ownerMatches: true,
        routePresentBefore: true,
        remaining: { ...emptyCounts(), routes: 2 },
      }),
    ).toEqual({ kind: 'retryable-failure', reason: 'incomplete-delete' });
  });
});

function emptyCounts() {
  return {
    routes: 0,
    cards: 0,
    mutationReceipts: 0,
    conflicts: 0,
    syncStates: 0,
    displayIds: 0,
    syncCommits: 0,
    syncChanges: 0,
    encryptedObjects: 0,
    encryptedWriteIntents: 0,
  } as const;
}
