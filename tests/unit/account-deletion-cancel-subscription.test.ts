import { describe, expect, it, vi } from 'vitest';
import {
  planAccountDeletionStart,
  planAccountDeletionStepClaim,
  planAccountDeletionStepResult,
} from '@/server/account-deletion/core';
import {
  executeCancelSubscriptionStep,
  mapCancelSubscriptionStepResult,
  planCancelSubscriptionStep,
} from '@/server/account-deletion/cancel-subscription';
import type {
  AccountDeletionOperation,
  AccountDeletionSnapshot,
  AccountDeletionTransition,
} from '@/server/account-deletion/public';
import type {
  ImmediateSubscriptionCancellationPort,
  ImmediateSubscriptionCancellationResult,
} from '@/server/billing/public';
import {
  accountDeletionFixtureIds,
  accountDeletionScopeFixture,
  requireDeletionOperation,
} from '@/tests/fixtures/account-deletion';

describe('account deletion subscription cancellation step', () => {
  it('requires a valid revoke receipt before planning the running cancel step', () => {
    const running = cancelRunningSnapshot();
    expect(
      planCancelSubscriptionStep({ snapshot: running, executedAt: 1_200 }),
    ).toEqual({
      kind: 'accepted',
      command: {
        ...accountDeletionScopeFixture(),
        idempotencyKey: accountDeletionFixtureIds.operationA,
        requestedAt: 1_100,
      },
      attempt: 1,
      finishedAt: 1_200,
    });
    expect(
      planCancelSubscriptionStep({
        snapshot: { ...running, receipts: [] },
        executedAt: 1_200,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-snapshot' });
    expect(
      planCancelSubscriptionStep({
        snapshot: revokeRunningSnapshot(),
        executedAt: 1_200,
      }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-step' });
    expect(
      planCancelSubscriptionStep({
        snapshot: cancelReadySnapshot(),
        executedAt: 1_200,
      }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-state' });
    expect(
      planCancelSubscriptionStep({ snapshot: running, executedAt: 1_099 }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-timestamp' });
  });

  it('maps only confirmed cancellation to success and keeps failures typed', () => {
    const plan = planCancelSubscriptionStep({
      snapshot: cancelRunningSnapshot(),
      executedAt: 1_200,
    });
    if (plan.kind !== 'accepted') throw new Error('invalid plan fixture');
    const cases: readonly [
      (
        | ImmediateSubscriptionCancellationResult
        | {
            readonly kind: 'unavailable';
          }
      ),
      string,
      string | undefined,
    ][] = [
      [
        {
          kind: 'confirmed',
          outcome: 'cancelled',
          confirmedAt: 1_100,
          accessEndsAt: 1_100,
        },
        'succeeded',
        undefined,
      ],
      [
        {
          kind: 'confirmed',
          outcome: 'already-cancelled',
          confirmedAt: 1_100,
          accessEndsAt: 1_100,
        },
        'succeeded',
        undefined,
      ],
      [
        { kind: 'unavailable' },
        'retryable-failure',
        'subscription-cancellation-unavailable',
      ],
      [
        { kind: 'retryable-failure', reason: 'provider-unavailable' },
        'retryable-failure',
        'subscription-cancellation-incomplete',
      ],
      [
        { kind: 'terminal-failure', reason: 'owner-mismatch' },
        'terminal-failure',
        'subscription-owner-mismatch',
      ],
      [
        { kind: 'terminal-failure', reason: 'provider-terminal' },
        'terminal-failure',
        'subscription-cancellation-terminal',
      ],
    ];
    for (const [cancellation, kind, failureCode] of cases) {
      expect(mapCancelSubscriptionStepResult(plan, cancellation)).toMatchObject(
        {
          kind,
          step: 'cancel-subscription',
          attempt: 1,
          finishedAt: 1_200,
          ...(failureCode === undefined ? {} : { failureCode }),
        },
      );
    }
  });

  it('executes through Billing public API and produces a saga receipt input', async () => {
    const snapshot = cancelRunningSnapshot();
    const cancelSubscriptionImmediately = vi.fn(async () => ({
      kind: 'confirmed' as const,
      outcome: 'cancelled' as const,
      confirmedAt: 1_100,
      accessEndsAt: 1_100,
    }));
    const execution = await executeCancelSubscriptionStep({
      snapshot,
      executedAt: 1_200,
      billing: { cancelSubscriptionImmediately },
    });
    expect(cancelSubscriptionImmediately).toHaveBeenCalledWith({
      ...accountDeletionScopeFixture(),
      idempotencyKey: accountDeletionFixtureIds.operationA,
      requestedAt: 1_100,
    });
    if (execution.kind !== 'executed') {
      throw new Error('cancellation was not executed');
    }
    const transition = planAccountDeletionStepResult({
      operation: snapshot.operation,
      result: execution.result,
      retryPolicy: { delaysMs: [100] },
    });
    expect(transition).toMatchObject({
      kind: 'accepted',
      transition: {
        receipt: { step: 'cancel-subscription', completedAt: 1_200 },
        next: { state: { kind: 'ready', step: 'delete-vault-data' } },
      },
    });
  });

  it('turns an unexpected port exception into retryable failure and skips invalid snapshots', async () => {
    const unavailable: ImmediateSubscriptionCancellationPort = {
      cancelSubscriptionImmediately: async () => {
        throw new Error('fixture unavailable');
      },
    };
    await expect(
      executeCancelSubscriptionStep({
        snapshot: cancelRunningSnapshot(),
        executedAt: 1_200,
        billing: unavailable,
      }),
    ).resolves.toMatchObject({
      kind: 'executed',
      result: {
        kind: 'retryable-failure',
        failureCode: 'subscription-cancellation-unavailable',
      },
    });

    const cancelSubscriptionImmediately = vi.fn(async () => ({
      kind: 'confirmed' as const,
      outcome: 'cancelled' as const,
      confirmedAt: 1_200,
      accessEndsAt: 1_200,
    }));
    const snapshot = cancelRunningSnapshot();
    await expect(
      executeCancelSubscriptionStep({
        snapshot: { ...snapshot, receipts: [] },
        executedAt: 1_200,
        billing: { cancelSubscriptionImmediately },
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'invalid-snapshot' });
    expect(cancelSubscriptionImmediately).not.toHaveBeenCalled();
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
    leaseExpiresAt: startedAt + 1_000,
  });
  if (plan.kind !== 'accepted') throw new Error('invalid claim fixture');
  return plan.transition;
}

function revokeRunningSnapshot(): AccountDeletionSnapshot {
  return { operation: claim(newOperation(), 1_000).next, receipts: [] };
}

function cancelReadySnapshot(): AccountDeletionSnapshot {
  const running = revokeRunningSnapshot().operation;
  if (running.state.kind !== 'running') {
    throw new Error('invalid running fixture');
  }
  const success = planAccountDeletionStepResult({
    operation: running,
    result: {
      kind: 'succeeded',
      step: 'revoke-sessions',
      attempt: running.state.attempt,
      finishedAt: 1_100,
    },
    retryPolicy: { delaysMs: [100] },
  });
  if (success.kind !== 'accepted' || success.transition.receipt === undefined) {
    throw new Error('invalid revoke success fixture');
  }
  return {
    operation: success.transition.next,
    receipts: [success.transition.receipt],
  };
}

function cancelRunningSnapshot(): AccountDeletionSnapshot {
  const ready = cancelReadySnapshot();
  return {
    operation: claim(ready.operation, 1_100).next,
    receipts: ready.receipts,
  };
}
