import { describe, expect, it, vi } from 'vitest';
import {
  planAccountDeletionStart,
  planAccountDeletionStepClaim,
  planAccountDeletionStepResult,
} from '@/server/account-deletion/core';
import {
  evaluateAccountLiveStateFinalization,
  evaluatePrivateObjectReconfirmation,
  evaluateWrappedKeyFinalization,
  planFinalizeAccountStep,
} from '@/server/account-deletion/finalize-account-core';
import { executeFinalizeAccountStep } from '@/server/account-deletion/finalize-account';
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

describe('account deletion finalization step', () => {
  it('requires the ordered private-object receipt and derives the owner scope', () => {
    const snapshot = finalizationRunningSnapshot();
    expect(planFinalizeAccountStep({ snapshot, executedAt: 1_500 })).toEqual({
      kind: 'accepted',
      scope: accountDeletionScopeFixture(),
      attempt: 1,
      finishedAt: 1_500,
    });
    expect(
      planFinalizeAccountStep({
        snapshot: { ...snapshot, receipts: snapshot.receipts.slice(0, 3) },
        executedAt: 1_500,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-snapshot' });
    expect(
      planFinalizeAccountStep({
        snapshot: privateObjectsRunningSnapshot(),
        executedAt: 1_500,
      }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-step' });
    expect(planFinalizeAccountStep({ snapshot, executedAt: 1_399 })).toEqual({
      kind: 'rejected',
      reason: 'invalid-timestamp',
    });
  });

  it('stops before wrapped-key destruction when object deletion cannot be reconfirmed', async () => {
    const privateObjects = vi.fn(async () => ({
      kind: 'retryable-failure' as const,
      reason: 'objects-remaining' as const,
    }));
    const finalizeVaultWrappedKeys = vi.fn(async () => ({
      kind: 'confirmed' as const,
      outcome: 'deleted' as const,
    }));
    const finalizeAccountLiveState = vi.fn(async () => ({
      kind: 'confirmed' as const,
      outcome: 'deleted' as const,
    }));

    await expect(
      executeFinalizeAccountStep({
        snapshot: finalizationRunningSnapshot(),
        executedAt: 1_500,
        privateObjects: { confirmVaultPrivateObjectDeletion: privateObjects },
        wrappedKeys: { finalizeVaultWrappedKeys },
        controlPlane: { finalizeAccountLiveState },
      }),
    ).resolves.toMatchObject({
      kind: 'executed',
      result: {
        kind: 'retryable-failure',
        failureCode: 'private-object-reconfirmation-incomplete',
      },
    });
    expect(finalizeVaultWrappedKeys).not.toHaveBeenCalled();
    expect(finalizeAccountLiveState).not.toHaveBeenCalled();
  });

  it('keeps the effect order and resumes after wrapped-key or control-plane failure', async () => {
    const calls: string[] = [];
    const confirmVaultPrivateObjectDeletion = vi.fn(async () => {
      calls.push('objects');
      return {
        kind: 'confirmed' as const,
        outcome: 'empty' as const,
      };
    });
    const finalizeVaultWrappedKeys = vi
      .fn()
      .mockImplementationOnce(async () => {
        calls.push('keys');
        return {
          kind: 'retryable-failure' as const,
          reason: 'incomplete-finalization' as const,
        };
      })
      .mockImplementation(async () => {
        calls.push('keys');
        return {
          kind: 'confirmed' as const,
          outcome: 'already-finalized' as const,
        };
      });
    const finalizeAccountLiveState = vi
      .fn()
      .mockImplementationOnce(async () => {
        calls.push('account');
        return {
          kind: 'retryable-failure' as const,
          reason: 'incomplete-finalization' as const,
        };
      })
      .mockImplementation(async () => {
        calls.push('account');
        return {
          kind: 'confirmed' as const,
          outcome: 'already-finalized' as const,
        };
      });
    const input = {
      snapshot: finalizationRunningSnapshot(),
      executedAt: 1_500,
      privateObjects: { confirmVaultPrivateObjectDeletion },
      wrappedKeys: { finalizeVaultWrappedKeys },
      controlPlane: { finalizeAccountLiveState },
    } as const;

    await expect(executeFinalizeAccountStep(input)).resolves.toMatchObject({
      result: {
        kind: 'retryable-failure',
        failureCode: 'wrapped-key-finalization-incomplete',
      },
    });
    expect(calls).toEqual(['objects', 'keys']);

    await expect(executeFinalizeAccountStep(input)).resolves.toMatchObject({
      result: {
        kind: 'retryable-failure',
        failureCode: 'account-live-state-incomplete',
      },
    });
    expect(calls).toEqual(['objects', 'keys', 'objects', 'keys', 'account']);

    const completed = await executeFinalizeAccountStep(input);
    expect(calls).toEqual([
      'objects',
      'keys',
      'objects',
      'keys',
      'account',
      'objects',
      'keys',
      'account',
    ]);
    if (completed.kind !== 'executed') {
      throw new Error('finalization was not executed');
    }
    expect(
      planAccountDeletionStepResult({
        operation: input.snapshot.operation,
        result: completed.result,
        retryPolicy: { delaysMs: [100] },
      }),
    ).toMatchObject({
      kind: 'accepted',
      transition: {
        receipt: { step: 'finalize-account', completedAt: 1_500 },
        next: { state: { kind: 'completed', completedAt: 1_500 } },
      },
    });
  });

  it('maps unavailable and owner-mismatch effects to non-sensitive failures', () => {
    const plan = acceptedPlan();
    expect(
      evaluatePrivateObjectReconfirmation(plan, { kind: 'unavailable' }),
    ).toMatchObject({
      result: { failureCode: 'private-object-reconfirmation-unavailable' },
    });
    expect(
      evaluateWrappedKeyFinalization(plan, {
        kind: 'terminal-failure',
        reason: 'owner-mismatch',
      }),
    ).toMatchObject({
      result: {
        kind: 'terminal-failure',
        failureCode: 'wrapped-key-owner-mismatch',
      },
    });
    expect(
      evaluateAccountLiveStateFinalization(plan, {
        kind: 'terminal-failure',
        reason: 'owner-mismatch',
      }),
    ).toMatchObject({
      kind: 'terminal-failure',
      failureCode: 'account-live-owner-mismatch',
    });
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

function privateObjectsRunningSnapshot(): AccountDeletionSnapshot {
  let operation = newOperation();
  const receipts: AccountDeletionStepReceipt[] = [];
  const steps = [
    'revoke-sessions',
    'cancel-subscription',
    'delete-vault-data',
  ] as const;
  for (const [index, step] of steps.entries()) {
    const running = claim(operation, 1_000 + index * 100).next;
    const completed = succeed(running, step, 1_100 + index * 100);
    operation = completed.operation;
    receipts.push(completed.receipt);
  }
  return { operation: claim(operation, 1_300).next, receipts };
}

function finalizationRunningSnapshot(): AccountDeletionSnapshot {
  const privateObjects = privateObjectsRunningSnapshot();
  const deleted = succeed(
    privateObjects.operation,
    'delete-private-objects',
    1_400,
  );
  return {
    operation: claim(deleted.operation, 1_400).next,
    receipts: [...privateObjects.receipts, deleted.receipt],
  };
}

function acceptedPlan() {
  const plan = planFinalizeAccountStep({
    snapshot: finalizationRunningSnapshot(),
    executedAt: 1_500,
  });
  if (plan.kind !== 'accepted') throw new Error('invalid plan fixture');
  return plan;
}
