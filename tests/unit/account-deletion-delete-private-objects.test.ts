import { describe, expect, it, vi } from 'vitest';
import {
  planAccountDeletionStart,
  planAccountDeletionStepClaim,
  planAccountDeletionStepResult,
} from '@/server/account-deletion/core';
import {
  mapDeletePrivateObjectsStepResult,
  planDeletePrivateObjectsStep,
} from '@/server/account-deletion/delete-private-objects-core';
import { executeDeletePrivateObjectsStep } from '@/server/account-deletion/delete-private-objects';
import type {
  AccountDeletionOperation,
  AccountDeletionSnapshot,
  AccountDeletionStep,
  AccountDeletionStepReceipt,
  AccountDeletionTransition,
} from '@/server/account-deletion/public';
import type { VaultPrivateObjectPurgeResult } from '@/server/encrypted-object/public';
import {
  accountDeletionFixtureIds,
  accountDeletionScopeFixture,
  requireDeletionOperation,
} from '@/tests/fixtures/account-deletion';

describe('account deletion private-object step', () => {
  it('requires every prior receipt and derives scope from the running operation', () => {
    const snapshot = privateObjectsRunningSnapshot();
    expect(
      planDeletePrivateObjectsStep({ snapshot, executedAt: 1_400 }),
    ).toEqual({
      kind: 'accepted',
      scope: accountDeletionScopeFixture(),
      attemptedAt: 1_400,
      attempt: 1,
      finishedAt: 1_400,
    });
    expect(
      planDeletePrivateObjectsStep({
        snapshot: { ...snapshot, receipts: snapshot.receipts.slice(0, 2) },
        executedAt: 1_400,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-snapshot' });
    expect(
      planDeletePrivateObjectsStep({
        snapshot: deleteVaultDataRunningSnapshot(),
        executedAt: 1_400,
      }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-step' });
    expect(
      planDeletePrivateObjectsStep({ snapshot, executedAt: 1_299 }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-timestamp' });
  });

  it('maps only confirmed deletion to success and keeps failures non-sensitive', () => {
    const plan = acceptedPlan();
    const cases: readonly [
      VaultPrivateObjectPurgeResult | { readonly kind: 'unavailable' },
      string,
      string | undefined,
    ][] = [
      [{ kind: 'confirmed', outcome: 'deleted' }, 'succeeded', undefined],
      [{ kind: 'confirmed', outcome: 'already-empty' }, 'succeeded', undefined],
      [
        { kind: 'retryable-failure', reason: 'objects-remaining' },
        'retryable-failure',
        'private-object-delete-incomplete',
      ],
      [
        { kind: 'retryable-failure', reason: 'storage-unavailable' },
        'retryable-failure',
        'private-object-storage-unavailable',
      ],
      [
        { kind: 'retryable-failure', reason: 'outbox-unavailable' },
        'retryable-failure',
        'private-object-outbox-unavailable',
      ],
      [
        {
          kind: 'retryable-failure',
          reason: 'delete-confirmation-unavailable',
        },
        'retryable-failure',
        'private-object-confirmation-unavailable',
      ],
      [
        { kind: 'terminal-failure', reason: 'owner-mismatch' },
        'terminal-failure',
        'private-object-owner-mismatch',
      ],
      [
        { kind: 'terminal-failure', reason: 'invalid-command' },
        'terminal-failure',
        'private-object-command-rejected',
      ],
      [
        { kind: 'unavailable' },
        'retryable-failure',
        'private-object-outbox-unavailable',
      ],
    ];
    for (const [effect, kind, failureCode] of cases) {
      expect(mapDeletePrivateObjectsStepResult(plan, effect)).toMatchObject({
        kind,
        step: 'delete-private-objects',
        attempt: 1,
        finishedAt: 1_400,
        ...(failureCode === undefined ? {} : { failureCode }),
      });
    }
  });

  it('executes through the public purge port and advances only after confirmation', async () => {
    const snapshot = privateObjectsRunningSnapshot();
    const purgeVaultPrivateObjects = vi.fn(async () => ({
      kind: 'confirmed' as const,
      outcome: 'deleted' as const,
    }));
    const execution = await executeDeletePrivateObjectsStep({
      snapshot,
      executedAt: 1_400,
      encryptedObjects: { purgeVaultPrivateObjects },
    });
    expect(purgeVaultPrivateObjects).toHaveBeenCalledWith({
      scope: accountDeletionScopeFixture(),
      attemptedAt: 1_400,
    });
    if (execution.kind !== 'executed') {
      throw new Error('private-object purge was not executed');
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
        receipt: { step: 'delete-private-objects', completedAt: 1_400 },
        next: { state: { kind: 'ready', step: 'finalize-account' } },
      },
    });
  });

  it('turns a port exception into retryable failure and skips invalid state', async () => {
    await expect(
      executeDeletePrivateObjectsStep({
        snapshot: privateObjectsRunningSnapshot(),
        executedAt: 1_400,
        encryptedObjects: {
          purgeVaultPrivateObjects: async () => {
            throw new Error('fixture unavailable');
          },
        },
      }),
    ).resolves.toMatchObject({
      kind: 'executed',
      result: {
        kind: 'retryable-failure',
        failureCode: 'private-object-outbox-unavailable',
      },
    });

    const purgeVaultPrivateObjects = vi.fn(async () => ({
      kind: 'confirmed' as const,
      outcome: 'already-empty' as const,
    }));
    await expect(
      executeDeletePrivateObjectsStep({
        snapshot: deleteVaultDataRunningSnapshot(),
        executedAt: 1_400,
        encryptedObjects: { purgeVaultPrivateObjects },
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'wrong-step' });
    expect(purgeVaultPrivateObjects).not.toHaveBeenCalled();
  });
});

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
    leaseExpiresAt: startedAt + 100,
  });
  if (plan.kind !== 'accepted') throw new Error('invalid claim fixture');
  return plan.transition;
}

function succeed(
  operation: AccountDeletionOperation,
  step: AccountDeletionStep,
  finishedAt: number,
): {
  readonly operation: AccountDeletionOperation;
  readonly receipt: AccountDeletionStepReceipt;
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

function deleteVaultDataRunningSnapshot(): AccountDeletionSnapshot {
  const revoke = succeed(
    claim(newOperation(), 1_000).next,
    'revoke-sessions',
    1_100,
  );
  const cancel = succeed(
    claim(revoke.operation, 1_100).next,
    'cancel-subscription',
    1_200,
  );
  return {
    operation: claim(cancel.operation, 1_200).next,
    receipts: [revoke.receipt, cancel.receipt],
  };
}

function privateObjectsRunningSnapshot(): AccountDeletionSnapshot {
  const liveData = deleteVaultDataRunningSnapshot();
  const deleted = succeed(liveData.operation, 'delete-vault-data', 1_300);
  return {
    operation: claim(deleted.operation, 1_300).next,
    receipts: [...liveData.receipts, deleted.receipt],
  };
}

function acceptedPlan() {
  const plan = planDeletePrivateObjectsStep({
    snapshot: privateObjectsRunningSnapshot(),
    executedAt: 1_400,
  });
  if (plan.kind !== 'accepted') throw new Error('invalid plan fixture');
  return plan;
}
