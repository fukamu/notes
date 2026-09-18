import { describe, expect, it } from 'vitest';
import {
  isInitialAccountDeletionOperation,
  isValidAccountDeletionSnapshot,
  isValidAccountDeletionTransition,
  planAccountDeletionExpiredLeaseRecovery,
  planAccountDeletionRetryResume,
  planAccountDeletionStart,
  planAccountDeletionStepClaim,
  planAccountDeletionStepResult,
  type AccountDeletionTransitionPlan,
} from '@/server/account-deletion/core';
import {
  accountDeletionOperationDecoder,
  accountDeletionSteps,
  parseAccountDeletionFailureCode,
  parseAccountDeletionOperationId,
  type AccountDeletionOperation,
  type AccountDeletionStepReceipt,
  type AccountDeletionTransition,
} from '@/server/account-deletion/public';
import {
  accountDeletionFailureCodes,
  accountDeletionFixtureIds,
  accountDeletionScopeFixture,
  requireDeletionOperation,
} from '@/tests/fixtures/account-deletion';

const retryPolicy = { delaysMs: [100, 200] } as const;

describe('account deletion saga core', () => {
  it('starts in the revoke-first state and validates its branded boundary values', () => {
    const operation = newOperation();
    expect(isInitialAccountDeletionOperation(operation)).toBe(true);
    expect(operation.state).toEqual({
      kind: 'ready',
      step: 'revoke-sessions',
      attempt: 0,
      notBefore: 1_000,
    });
    expect(
      planAccountDeletionStart({
        operationId: accountDeletionFixtureIds.operationA,
        scope: accountDeletionScopeFixture(),
        requestedAt: -1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-timestamp' });
    expect(() => parseAccountDeletionOperationId('not-a-uuid')).toThrow();
    expect(() => parseAccountDeletionFailureCode('secret details!')).toThrow();
  });

  it('requires a valid due time and lease before claiming a step', () => {
    const operation = newOperation();
    expect(
      planAccountDeletionStepClaim({
        operation,
        startedAt: 999,
        leaseExpiresAt: 2_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-timestamp' });
    expect(
      planAccountDeletionStepClaim({
        operation,
        startedAt: 1_000,
        leaseExpiresAt: 1_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-lease' });

    const transition = acceptedTransition(
      planAccountDeletionStepClaim({
        operation,
        startedAt: 1_000,
        leaseExpiresAt: 2_000,
      }),
    );
    expect(transition.next.state).toEqual({
      kind: 'running',
      step: 'revoke-sessions',
      attempt: 1,
      leaseExpiresAt: 2_000,
    });
    expect(
      isValidAccountDeletionTransition(
        accountDeletionScopeFixture(),
        transition,
      ),
    ).toBe(true);
  });

  it('advances through every step only after a receipt and completes with a receipt prefix', () => {
    let operation = newOperation();
    const receipts: AccountDeletionStepReceipt[] = [];
    let timestamp = 1_000;

    for (const expectedStep of accountDeletionSteps) {
      const claim = acceptedTransition(
        planAccountDeletionStepClaim({
          operation,
          startedAt: timestamp,
          leaseExpiresAt: timestamp + 50,
        }),
      );
      operation = claim.next;
      if (operation.state.kind !== 'running') {
        throw new Error('step was not claimed');
      }
      expect(operation.state.step).toBe(expectedStep);
      timestamp += 1;
      const success = acceptedTransition(
        planAccountDeletionStepResult({
          operation,
          result: {
            kind: 'succeeded',
            step: operation.state.step,
            attempt: operation.state.attempt,
            finishedAt: timestamp,
          },
          retryPolicy,
        }),
      );
      expect(success.receipt?.step).toBe(expectedStep);
      if (success.receipt === undefined) {
        throw new Error('success receipt missing');
      }
      receipts.push(success.receipt);
      operation = success.next;
      expect(isValidAccountDeletionSnapshot({ operation, receipts })).toBe(
        true,
      );
      timestamp += 1;
    }

    expect(operation.state).toEqual({
      kind: 'completed',
      completedAt: 1_009,
    });
    expect(receipts.map((receipt) => receipt.step)).toEqual(
      accountDeletionSteps,
    );
  });

  it('waits according to the injected retry policy and stops after it is exhausted', () => {
    let operation = claim(newOperation(), 1_000, 2_000);
    if (operation.state.kind !== 'running') throw new Error('not running');
    let failure = acceptedTransition(
      planAccountDeletionStepResult({
        operation,
        result: {
          kind: 'retryable-failure',
          step: operation.state.step,
          attempt: operation.state.attempt,
          finishedAt: 1_100,
          failureCode: accountDeletionFailureCodes.temporary,
        },
        retryPolicy,
      }),
    );
    operation = failure.next;
    expect(operation.state).toEqual({
      kind: 'retry-wait',
      step: 'revoke-sessions',
      attempt: 1,
      retryAt: 1_200,
      failureCode: accountDeletionFailureCodes.temporary,
    });
    expect(
      planAccountDeletionRetryResume({ operation, resumedAt: 1_199 }),
    ).toEqual({ kind: 'rejected', reason: 'not-ready' });

    operation = acceptedTransition(
      planAccountDeletionRetryResume({ operation, resumedAt: 1_200 }),
    ).next;
    operation = claim(operation, 1_200, 2_000);
    if (operation.state.kind !== 'running') throw new Error('not running');
    failure = acceptedTransition(
      planAccountDeletionStepResult({
        operation,
        result: {
          kind: 'retryable-failure',
          step: operation.state.step,
          attempt: operation.state.attempt,
          finishedAt: 1_300,
          failureCode: accountDeletionFailureCodes.temporary,
        },
        retryPolicy,
      }),
    );
    operation = acceptedTransition(
      planAccountDeletionRetryResume({
        operation: failure.next,
        resumedAt: 1_500,
      }),
    ).next;
    operation = claim(operation, 1_500, 2_000);
    if (operation.state.kind !== 'running') throw new Error('not running');
    operation = acceptedTransition(
      planAccountDeletionStepResult({
        operation,
        result: {
          kind: 'retryable-failure',
          step: operation.state.step,
          attempt: operation.state.attempt,
          finishedAt: 1_600,
          failureCode: accountDeletionFailureCodes.temporary,
        },
        retryPolicy,
      }),
    ).next;
    expect(operation.state).toEqual({
      kind: 'terminal-failure',
      step: 'revoke-sessions',
      attempt: 3,
      failureCode: accountDeletionFailureCodes.temporary,
    });
  });

  it('recovers an expired running lease through the same bounded retry path', () => {
    const operation = claim(newOperation(), 1_000, 1_100);
    expect(
      planAccountDeletionExpiredLeaseRecovery({
        operation,
        recoveredAt: 1_099,
        retryPolicy,
      }),
    ).toEqual({ kind: 'rejected', reason: 'not-ready' });
    const recovered = acceptedTransition(
      planAccountDeletionExpiredLeaseRecovery({
        operation,
        recoveredAt: 1_100,
        retryPolicy,
      }),
    );
    expect(recovered.next.state).toMatchObject({
      kind: 'retry-wait',
      failureCode: 'lease-expired',
      retryAt: 1_200,
    });
  });

  it('keeps terminal failures distinct and treats an already committed success receipt as replayed', () => {
    const running = claim(newOperation(), 1_000, 2_000);
    if (running.state.kind !== 'running') throw new Error('not running');
    const terminal = acceptedTransition(
      planAccountDeletionStepResult({
        operation: running,
        result: {
          kind: 'terminal-failure',
          step: running.state.step,
          attempt: running.state.attempt,
          finishedAt: 1_100,
          failureCode: accountDeletionFailureCodes.permanent,
        },
        retryPolicy,
      }),
    );
    expect(terminal.next.state.kind).toBe('terminal-failure');

    const success = acceptedTransition(
      planAccountDeletionStepResult({
        operation: running,
        result: {
          kind: 'succeeded',
          step: running.state.step,
          attempt: running.state.attempt,
          finishedAt: 1_100,
        },
        retryPolicy,
      }),
    );
    if (success.receipt === undefined) throw new Error('receipt missing');
    expect(
      planAccountDeletionStepResult({
        operation: success.next,
        result: {
          kind: 'succeeded',
          step: running.state.step,
          attempt: running.state.attempt,
          finishedAt: 1_200,
        },
        existingReceipt: success.receipt,
        retryPolicy,
      }),
    ).toEqual({ kind: 'replayed', operation: success.next });
  });

  it('rejects step substitution, malformed stored state, and cross-tenant transitions', () => {
    const running = claim(newOperation(), 1_000, 2_000);
    if (running.state.kind !== 'running') throw new Error('not running');
    expect(
      planAccountDeletionStepResult({
        operation: running,
        result: {
          kind: 'succeeded',
          step: 'cancel-subscription',
          attempt: running.state.attempt,
          finishedAt: 1_100,
        },
        retryPolicy,
      }),
    ).toEqual({ kind: 'rejected', reason: 'step-mismatch' });

    const success = acceptedTransition(
      planAccountDeletionStepResult({
        operation: running,
        result: {
          kind: 'succeeded',
          step: running.state.step,
          attempt: running.state.attempt,
          finishedAt: 1_100,
        },
        retryPolicy,
      }),
    );
    expect(
      isValidAccountDeletionTransition(
        accountDeletionScopeFixture('b'),
        success,
      ),
    ).toBe(false);
    expect(
      accountDeletionOperationDecoder.decode({
        ...success.next,
        state: {
          kind: 'retry-wait',
          step: 'revoke-sessions',
          attempt: -1,
          retryAt: 0,
          failureCode: 'details are not a code',
        },
      }).ok,
    ).toBe(false);
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

function acceptedTransition(
  plan: AccountDeletionTransitionPlan,
): AccountDeletionTransition {
  if (plan.kind !== 'accepted') {
    throw new Error(`expected accepted transition, received ${plan.kind}`);
  }
  return plan.transition;
}

function claim(
  operation: AccountDeletionOperation,
  startedAt: number,
  leaseExpiresAt: number,
): AccountDeletionOperation {
  return acceptedTransition(
    planAccountDeletionStepClaim({ operation, startedAt, leaseExpiresAt }),
  ).next;
}
