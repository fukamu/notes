import { describe, expect, it } from 'vitest';
import { decodeOrThrow } from '@/lib/codec/core';
import {
  planAccountDeletionStart,
  planAccountDeletionStepResult,
} from '@/server/account-deletion/core';
import {
  accountDeletionPublicStatus,
  planAccountDeletionContinuationConsume,
  planAccountDeletionContinuationStart,
  planAccountDeletionRun,
} from '@/server/account-deletion/http-core';
import {
  accountDeletionContinuationSequenceDecoder,
  accountDeletionResumeRequestDecoder,
  accountDeletionStartRequestDecoder,
  accountDeletionContinuationTokenParts,
  createAccountDeletionContinuationToken,
  parseAccountDeletionContinuationSecret,
  parseAccountDeletionCredentialHash,
  parseAccountDeletionIdempotencyKey,
  type AccountDeletionOperation,
  type AccountDeletionSnapshot,
  type AccountDeletionTransition,
} from '@/server/account-deletion/public';
import {
  accountDeletionFailureCodes,
  accountDeletionFixtureIds,
  accountDeletionScopeFixture,
  requireDeletionOperation,
} from '@/tests/fixtures/account-deletion';

const retryPolicy = { delaysMs: [100] } as const;
const idempotencyKey = parseAccountDeletionIdempotencyKey('I'.repeat(43));
const secret = parseAccountDeletionContinuationSecret('S'.repeat(43));
const idempotencyKeyHash = parseAccountDeletionCredentialHash('H'.repeat(43));
const secretHash = parseAccountDeletionCredentialHash('D'.repeat(43));

describe('account deletion HTTP pure core', () => {
  it('decodes only the narrow start and resume bodies', () => {
    expect(
      accountDeletionStartRequestDecoder.decode({ idempotencyKey }).ok,
    ).toBe(true);
    expect(
      accountDeletionStartRequestDecoder.decode({
        idempotencyKey,
        accountId: accountDeletionScopeFixture().accountId,
      }).ok,
    ).toBe(false);
    const continuationToken = createAccountDeletionContinuationToken(
      secret,
      sequence(0),
    );
    expect(
      accountDeletionResumeRequestDecoder.decode({ continuationToken }).ok,
    ).toBe(true);
    expect(accountDeletionContinuationTokenParts(continuationToken)).toEqual({
      secret,
      sequence: 0,
    });
  });

  it('creates a short-lived hash-only record and consumes each sequence once', () => {
    const start = planAccountDeletionContinuationStart({
      operation: newOperation(),
      idempotencyKeyHash,
      secretHash,
      expiresAt: 2_000,
    });
    expect(start.kind).toBe('accepted');
    if (start.kind !== 'accepted') throw new Error('start rejected');
    expect(start.continuation).toEqual({
      operationId: accountDeletionFixtureIds.operationA,
      idempotencyKeyHash,
      secretHash,
      sequence: 0,
      expiresAt: 2_000,
      createdAt: 1_000,
      updatedAt: 1_000,
    });

    const consumed = planAccountDeletionContinuationConsume({
      continuation: start.continuation,
      presentedSequence: sequence(0),
      consumedAt: 1_100,
    });
    expect(consumed).toMatchObject({
      kind: 'consume',
      next: { sequence: 1, updatedAt: 1_100 },
    });
    if (consumed.kind !== 'consume') throw new Error('consume rejected');
    expect(
      planAccountDeletionContinuationConsume({
        continuation: consumed.next,
        presentedSequence: sequence(0),
        consumedAt: 1_101,
      }),
    ).toEqual({ kind: 'replay' });
    expect(
      planAccountDeletionContinuationConsume({
        continuation: consumed.next,
        presentedSequence: sequence(9),
        consumedAt: 1_101,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-capability' });
    expect(
      planAccountDeletionContinuationConsume({
        continuation: consumed.next,
        presentedSequence: sequence(1),
        consumedAt: 2_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'expired' });
  });

  it('plans only due transitions and exposes no owner or failure detail', () => {
    const initial: AccountDeletionSnapshot = {
      operation: newOperation(),
      receipts: [],
    };
    const claim = planAccountDeletionRun({
      snapshot: initial,
      now: 1_000,
      leaseDurationMs: 500,
      retryPolicy,
    });
    expect(claim).toMatchObject({
      kind: 'claim-step',
      transition: {
        next: { state: { kind: 'running', step: 'revoke-sessions' } },
      },
    });
    if (claim.kind !== 'claim-step') throw new Error('claim not planned');
    const running = claim.transition.next;
    if (running.state.kind !== 'running') throw new Error('not running');
    expect(
      planAccountDeletionRun({
        snapshot: { operation: running, receipts: [] },
        now: 1_499,
        leaseDurationMs: 500,
        retryPolicy,
      }),
    ).toEqual({ kind: 'report' });
    expect(
      planAccountDeletionRun({
        snapshot: { operation: running, receipts: [] },
        now: 1_500,
        leaseDurationMs: 500,
        retryPolicy,
      }),
    ).toMatchObject({ kind: 'advance-state' });

    const failed = acceptedTransition(
      planAccountDeletionStepResult({
        operation: running,
        result: {
          kind: 'terminal-failure',
          step: 'revoke-sessions',
          attempt: running.state.attempt,
          finishedAt: 1_100,
          failureCode: accountDeletionFailureCodes.permanent,
        },
        retryPolicy,
      }),
    ).next;
    expect(
      accountDeletionPublicStatus({ operation: failed, receipts: [] }),
    ).toEqual({ kind: 'failed' });
    expect(
      JSON.stringify(
        accountDeletionPublicStatus({ operation: failed, receipts: [] }),
      ),
    ).not.toMatch(/account|vault|provider-refused/);
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

function sequence(value: number) {
  return decodeOrThrow(
    accountDeletionContinuationSequenceDecoder,
    value,
    'test continuation sequence',
  );
}

function acceptedTransition(plan: {
  readonly kind: string;
  readonly transition?: AccountDeletionTransition;
}): AccountDeletionTransition {
  if (plan.kind !== 'accepted' || plan.transition === undefined) {
    throw new Error(`expected accepted transition, received ${plan.kind}`);
  }
  return plan.transition;
}
