import { describe, expect, it, vi } from 'vitest';
import {
  planAccountDeletionStart,
  planAccountDeletionStepClaim,
  planAccountDeletionStepResult,
} from '@/server/account-deletion/core';
import {
  evaluateEncryptedMetadataPurge,
  evaluateVaultLiveDataDelete,
  planDeleteVaultDataStep,
} from '@/server/account-deletion/delete-vault-data-core';
import { executeDeleteVaultDataStep } from '@/server/account-deletion/delete-vault-data';
import type {
  AccountDeletionOperation,
  AccountDeletionSnapshot,
  AccountDeletionStep,
  AccountDeletionStepReceipt,
  AccountDeletionTransition,
} from '@/server/account-deletion/public';
import {
  accountDeletionFixtureIds,
  accountDeletionScopeFixture,
  requireDeletionOperation,
} from '@/tests/fixtures/account-deletion';

describe('account deletion Vault live-data step', () => {
  it('requires both prior barriers and derives a stable outbox timestamp', () => {
    const snapshot = deleteRunningSnapshot();
    expect(planDeleteVaultDataStep({ snapshot, executedAt: 1_300 })).toEqual({
      kind: 'accepted',
      scope: accountDeletionScopeFixture(),
      requestedAt: 1_200,
      attempt: 1,
      finishedAt: 1_300,
    });
    expect(
      planDeleteVaultDataStep({
        snapshot: { ...snapshot, receipts: snapshot.receipts.slice(0, 1) },
        executedAt: 1_300,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-snapshot' });
    expect(
      planDeleteVaultDataStep({
        snapshot: cancelRunningSnapshot(),
        executedAt: 1_300,
      }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-step' });
    expect(planDeleteVaultDataStep({ snapshot, executedAt: 1_199 })).toEqual({
      kind: 'rejected',
      reason: 'invalid-timestamp',
    });
  });

  it('continues only after object inventory is confirmed or the route is already absent', () => {
    const plan = acceptedPlan();
    expect(
      evaluateEncryptedMetadataPurge(plan, {
        kind: 'confirmed',
        outcome: 'purged',
      }),
    ).toEqual({ kind: 'continue' });
    expect(
      evaluateEncryptedMetadataPurge(plan, { kind: 'route-not-found' }),
    ).toEqual({ kind: 'continue' });
    expect(
      evaluateEncryptedMetadataPurge(plan, { kind: 'unavailable' }),
    ).toMatchObject({
      kind: 'complete',
      result: {
        kind: 'retryable-failure',
        failureCode: 'encrypted-object-inventory-unavailable',
      },
    });
    expect(
      evaluateEncryptedMetadataPurge(plan, {
        kind: 'retryable-failure',
        reason: 'incomplete-inventory',
      }),
    ).toMatchObject({
      kind: 'complete',
      result: {
        kind: 'retryable-failure',
        failureCode: 'encrypted-object-inventory-incomplete',
      },
    });
  });

  it('advances only after Vault content confirms zero live rows', () => {
    const plan = acceptedPlan();
    expect(
      evaluateVaultLiveDataDelete(plan, {
        kind: 'confirmed',
        outcome: 'purged',
      }),
    ).toEqual({
      kind: 'succeeded',
      step: 'delete-vault-data',
      attempt: 1,
      finishedAt: 1_300,
    });
    expect(
      evaluateVaultLiveDataDelete(plan, { kind: 'unavailable' }),
    ).toMatchObject({
      kind: 'retryable-failure',
      failureCode: 'vault-live-data-unavailable',
    });
    expect(
      evaluateVaultLiveDataDelete(plan, {
        kind: 'retryable-failure',
        reason: 'object-inventory-not-empty',
      }),
    ).toMatchObject({
      kind: 'retryable-failure',
      failureCode: 'vault-live-data-incomplete',
    });
    expect(
      evaluateVaultLiveDataDelete(plan, {
        kind: 'terminal-failure',
        reason: 'owner-mismatch',
      }),
    ).toMatchObject({
      kind: 'terminal-failure',
      failureCode: 'vault-owner-mismatch',
    });
  });

  it('executes metadata before content and leaves the content port untouched on incomplete inventory', async () => {
    const calls: string[] = [];
    const purgeVaultMetadata = vi.fn(async () => {
      calls.push('metadata');
      return { kind: 'confirmed' as const, outcome: 'purged' as const };
    });
    const purgeVaultLiveData = vi.fn(async () => {
      calls.push('content');
      return { kind: 'confirmed' as const, outcome: 'purged' as const };
    });
    const snapshot = deleteRunningSnapshot();
    const execution = await executeDeleteVaultDataStep({
      snapshot,
      executedAt: 1_300,
      encryptedObjects: { purgeVaultMetadata },
      vaultContent: { purgeVaultLiveData },
    });
    expect(execution).toMatchObject({
      kind: 'executed',
      result: { kind: 'succeeded', step: 'delete-vault-data' },
    });
    if (execution.kind !== 'executed') {
      throw new Error('Vault live-data purge was not executed');
    }
    expect(
      planAccountDeletionStepResult({
        operation: snapshot.operation,
        result: execution.result,
        retryPolicy: { delaysMs: [100] },
      }),
    ).toMatchObject({
      kind: 'accepted',
      transition: {
        receipt: { step: 'delete-vault-data', completedAt: 1_300 },
        next: { state: { kind: 'ready', step: 'delete-private-objects' } },
      },
    });
    expect(calls).toEqual(['metadata', 'content']);
    expect(purgeVaultMetadata).toHaveBeenCalledWith({
      scope: accountDeletionScopeFixture(),
      requestedAt: 1_200,
    });

    const skippedContent = vi.fn(async () => ({
      kind: 'confirmed' as const,
      outcome: 'purged' as const,
    }));
    await expect(
      executeDeleteVaultDataStep({
        snapshot: deleteRunningSnapshot(),
        executedAt: 1_300,
        encryptedObjects: {
          purgeVaultMetadata: async () => ({
            kind: 'retryable-failure',
            reason: 'incomplete-inventory',
          }),
        },
        vaultContent: { purgeVaultLiveData: skippedContent },
      }),
    ).resolves.toMatchObject({
      kind: 'executed',
      result: { kind: 'retryable-failure' },
    });
    expect(skippedContent).not.toHaveBeenCalled();
  });

  it('recovers a lost final response when both D1 phases are already complete', async () => {
    await expect(
      executeDeleteVaultDataStep({
        snapshot: deleteRunningSnapshot(),
        executedAt: 1_400,
        encryptedObjects: {
          purgeVaultMetadata: async () => ({ kind: 'route-not-found' }),
        },
        vaultContent: {
          purgeVaultLiveData: async () => ({
            kind: 'confirmed',
            outcome: 'already-purged',
          }),
        },
      }),
    ).resolves.toMatchObject({
      kind: 'executed',
      result: { kind: 'succeeded', finishedAt: 1_400 },
    });
  });
});

function acceptedPlan() {
  const plan = planDeleteVaultDataStep({
    snapshot: deleteRunningSnapshot(),
    executedAt: 1_300,
  });
  if (plan.kind !== 'accepted') throw new Error('invalid plan fixture');
  return plan;
}

function newOperation(): AccountDeletionOperation {
  return requireDeletionOperation(
    planAccountDeletionStart({
      operationId: accountDeletionFixtureIds.operationA,
      scope: accountDeletionScopeFixture(),
      requestedAt: 1_000,
    }),
  );
}

function claim(
  operation: AccountDeletionOperation,
  startedAt: number,
): AccountDeletionTransition {
  const plan = planAccountDeletionStepClaim({
    operation,
    startedAt,
    leaseExpiresAt: startedAt + 1_000,
  });
  if (plan.kind !== 'accepted') throw new Error('invalid claim fixture');
  return plan.transition;
}

function succeed(
  operation: AccountDeletionOperation,
  step: AccountDeletionStep,
  finishedAt: number,
): {
  operation: AccountDeletionOperation;
  receipt: AccountDeletionStepReceipt;
} {
  if (operation.state.kind !== 'running') {
    throw new Error('invalid running fixture');
  }
  const plan = planAccountDeletionStepResult({
    operation,
    result: {
      kind: 'succeeded',
      step,
      attempt: operation.state.attempt,
      finishedAt,
    },
    retryPolicy: { delaysMs: [100] },
  });
  if (plan.kind !== 'accepted' || plan.transition.receipt === undefined) {
    throw new Error('invalid success fixture');
  }
  return {
    operation: plan.transition.next,
    receipt: plan.transition.receipt,
  };
}

function cancelRunningSnapshot(): AccountDeletionSnapshot {
  const revoke = succeed(
    claim(newOperation(), 1_000).next,
    'revoke-sessions',
    1_100,
  );
  return {
    operation: claim(revoke.operation, 1_100).next,
    receipts: [revoke.receipt],
  };
}

function deleteRunningSnapshot(): AccountDeletionSnapshot {
  const cancel = cancelRunningSnapshot();
  const cancelled = succeed(cancel.operation, 'cancel-subscription', 1_200);
  return {
    operation: claim(cancelled.operation, 1_200).next,
    receipts: [...cancel.receipts, cancelled.receipt],
  };
}
