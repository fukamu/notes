import { describe, expect, it, vi } from 'vitest';
import {
  planAccountDeletionStart,
  planAccountDeletionStepClaim,
  planAccountDeletionStepResult,
  type AccountDeletionTransitionPlan,
} from '@/server/account-deletion/core';
import {
  executeRevokeSessionsStep,
  mapRevokeSessionsStepResult,
  planRevokeSessionsStep,
} from '@/server/account-deletion/revoke-sessions';
import type { AccountDeletionOperation } from '@/server/account-deletion/public';
import type {
  AccountSessionRevocationPort,
  AccountSessionRevocationResult,
} from '@/server/control-plane/public';
import {
  accountDeletionFixtureIds,
  accountDeletionScopeFixture,
  requireDeletionOperation,
} from '@/tests/fixtures/account-deletion';

describe('account deletion session revocation step', () => {
  it('plans only the running revoke-sessions step with an injected timestamp', () => {
    const ready = newOperation();
    expect(
      planRevokeSessionsStep({ operation: ready, revokedAt: 1_100 }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-state' });
    const running = claim(ready);
    expect(
      planRevokeSessionsStep({ operation: running, revokedAt: 999 }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-timestamp' });
    expect(
      planRevokeSessionsStep({ operation: running, revokedAt: 1_100 }),
    ).toEqual({
      kind: 'accepted',
      command: { ...accountDeletionScopeFixture(), revokedAt: 1_100 },
      attempt: 1,
      finishedAt: 1_100,
    });

    const afterRevoke = succeeded(running, 1_100).next;
    const cancelSubscription = claim(afterRevoke, 1_101);
    expect(
      planRevokeSessionsStep({
        operation: cancelSubscription,
        revokedAt: 1_200,
      }),
    ).toEqual({ kind: 'rejected', reason: 'wrong-step' });
  });

  it('maps typed effect outcomes without exposing provider or error details', () => {
    const plan = planRevokeSessionsStep({
      operation: claim(newOperation()),
      revokedAt: 1_100,
    });
    if (plan.kind !== 'accepted') throw new Error('invalid plan fixture');

    const cases: readonly [
      AccountSessionRevocationResult | { readonly kind: 'unavailable' },
      string,
      string | undefined,
    ][] = [
      [{ kind: 'applied', revokedSessionCount: 2 }, 'succeeded', undefined],
      [
        { kind: 'unavailable' },
        'retryable-failure',
        'session-revocation-unavailable',
      ],
      [
        { kind: 'rejected', reason: 'incomplete-revocation' },
        'retryable-failure',
        'session-revocation-incomplete',
      ],
      [
        { kind: 'rejected', reason: 'invalid-result' },
        'retryable-failure',
        'session-revocation-incomplete',
      ],
      [
        { kind: 'rejected', reason: 'owner-mismatch' },
        'terminal-failure',
        'session-owner-mismatch',
      ],
      [
        { kind: 'rejected', reason: 'invalid-revocation-time' },
        'terminal-failure',
        'session-revocation-contract-rejected',
      ],
    ];
    for (const [effect, kind, failureCode] of cases) {
      expect(mapRevokeSessionsStepResult(plan, effect)).toMatchObject({
        kind,
        step: 'revoke-sessions',
        attempt: 1,
        finishedAt: 1_100,
        ...(failureCode === undefined ? {} : { failureCode }),
      });
    }
  });

  it('executes through the public port and produces a success receipt input', async () => {
    const running = claim(newOperation());
    const revokeAccountSessions = vi.fn(async () => ({
      kind: 'applied' as const,
      revokedSessionCount: 2,
    }));
    const execution = await executeRevokeSessionsStep({
      operation: running,
      revokedAt: 1_100,
      sessions: { revokeAccountSessions },
    });
    expect(revokeAccountSessions).toHaveBeenCalledWith({
      ...accountDeletionScopeFixture(),
      revokedAt: 1_100,
    });
    expect(execution.kind).toBe('executed');
    if (execution.kind !== 'executed') return;
    const transition = planAccountDeletionStepResult({
      operation: running,
      result: execution.result,
      retryPolicy: { delaysMs: [100] },
    });
    expect(transition.kind).toBe('accepted');
    if (transition.kind !== 'accepted') return;
    expect(transition.transition.receipt).toMatchObject({
      step: 'revoke-sessions',
      completedAt: 1_100,
    });
  });

  it('turns a port failure into a retryable saga result and skips invalid states', async () => {
    const unavailable: AccountSessionRevocationPort = {
      revokeAccountSessions: async () => {
        throw new Error('fixture unavailable');
      },
    };
    const running = claim(newOperation());
    await expect(
      executeRevokeSessionsStep({
        operation: running,
        revokedAt: 1_100,
        sessions: unavailable,
      }),
    ).resolves.toMatchObject({
      kind: 'executed',
      result: {
        kind: 'retryable-failure',
        failureCode: 'session-revocation-unavailable',
      },
    });

    const revokeAccountSessions = vi.fn(async () => ({
      kind: 'applied' as const,
      revokedSessionCount: 0,
    }));
    await expect(
      executeRevokeSessionsStep({
        operation: newOperation(),
        revokedAt: 1_100,
        sessions: { revokeAccountSessions },
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'wrong-state' });
    expect(revokeAccountSessions).not.toHaveBeenCalled();
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
  startedAt = 1_000,
): AccountDeletionOperation {
  const plan = planAccountDeletionStepClaim({
    operation,
    startedAt,
    leaseExpiresAt: startedAt + 1_000,
  });
  if (plan.kind !== 'accepted') throw new Error('invalid claim fixture');
  return plan.transition.next;
}

function succeeded(
  operation: AccountDeletionOperation,
  finishedAt: number,
): Extract<AccountDeletionTransitionPlan, { kind: 'accepted' }>['transition'] {
  if (operation.state.kind !== 'running') {
    throw new Error('invalid running fixture');
  }
  const plan = planAccountDeletionStepResult({
    operation,
    result: {
      kind: 'succeeded',
      step: operation.state.step,
      attempt: operation.state.attempt,
      finishedAt,
    },
    retryPolicy: { delaysMs: [100] },
  });
  if (plan.kind !== 'accepted') throw new Error('invalid success fixture');
  return plan.transition;
}
