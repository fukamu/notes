import { describe, expect, it } from 'vitest';
import {
  planAccountDeletionRetryResume,
  planAccountDeletionStart,
  planAccountDeletionStepClaim,
  planAccountDeletionStepResult,
} from '@/server/account-deletion/core';
import { executeCancelSubscriptionStep } from '@/server/account-deletion/cancel-subscription';
import type {
  AccountDeletionOperation,
  AccountDeletionSnapshot,
  AccountDeletionTransition,
} from '@/server/account-deletion/public';
import { createSubscriptionCancellationPort } from '@/server/billing/cancellation-service';
import { createFakeSubscriptionCancellationProvider } from '@/server/billing/fake-cancellation';
import { createFakeBillingModule } from '@/server/billing/fake';
import {
  accountDeletionFixtureIds,
  requireDeletionOperation,
} from '@/tests/fixtures/account-deletion';
import {
  beginCheckoutCommand,
  billingContext,
  trialStartedFact,
} from '@/tests/fixtures/billing';

describe('account deletion to Billing cancellation integration', () => {
  it('retries a lost response with one provider side effect before advancing the saga', async () => {
    const billing = createFakeBillingModule([billingContext()]);
    await billing.api.beginCheckout(billingContext(), beginCheckoutCommand());
    await billing.api.ingestVerifiedProviderFact(trialStartedFact());
    const provider = createFakeSubscriptionCancellationProvider({
      actions: ['cancelled-response-lost'],
    });
    const cancellation = createSubscriptionCancellationPort({
      repository: billing.repository,
      provider,
    });
    let snapshot = cancelRunningSnapshot();

    const first = await executeCancelSubscriptionStep({
      snapshot,
      executedAt: 1_200,
      billing: cancellation,
    });
    if (first.kind !== 'executed') throw new Error('first effect not executed');
    const failed = planAccountDeletionStepResult({
      operation: snapshot.operation,
      result: first.result,
      retryPolicy: { delaysMs: [100] },
    });
    if (failed.kind !== 'accepted') throw new Error('retry was not planned');
    snapshot = {
      operation: failed.transition.next,
      receipts: snapshot.receipts,
    };
    expect(snapshot).toMatchObject({
      operation: {
        state: {
          kind: 'retry-wait',
          step: 'cancel-subscription',
          retryAt: 1_300,
        },
      },
      receipts: [{ step: 'revoke-sessions' }],
    });

    const resumed = planAccountDeletionRetryResume({
      operation: snapshot.operation,
      resumedAt: 1_300,
    });
    if (resumed.kind !== 'accepted') throw new Error('retry not resumed');
    const claimed = claim(resumed.transition.next, 1_300);
    snapshot = { operation: claimed.next, receipts: snapshot.receipts };
    const second = await executeCancelSubscriptionStep({
      snapshot,
      executedAt: 1_400,
      billing: cancellation,
    });
    if (second.kind !== 'executed')
      throw new Error('second effect not executed');
    const succeeded = planAccountDeletionStepResult({
      operation: snapshot.operation,
      result: second.result,
      retryPolicy: { delaysMs: [100] },
    });
    if (
      succeeded.kind !== 'accepted' ||
      succeeded.transition.receipt === undefined
    ) {
      throw new Error('cancellation did not advance');
    }

    expect(succeeded.transition).toMatchObject({
      next: { state: { kind: 'ready', step: 'delete-vault-data' } },
      receipt: { step: 'cancel-subscription', completedAt: 1_400 },
    });
    expect(provider.cancellationSideEffectCount()).toBe(1);
    expect(provider.commands()).toHaveLength(2);
    expect(provider.commands()[0]?.idempotencyKey).toBe(
      provider.commands()[1]?.idempotencyKey,
    );
    expect(provider.commands()[0]?.requestedAt).toBe(1_100);
    expect(provider.commands()[1]?.requestedAt).toBe(1_100);
    await expect(
      billing.api.readSubscription(billingContext()),
    ).resolves.toMatchObject({ lifecycle: { kind: 'trialing' } });
  });
});

function newOperation(): AccountDeletionOperation {
  return requireDeletionOperation(
    planAccountDeletionStart({
      operationId: accountDeletionFixtureIds.operationA,
      scope: {
        accountId: billingContext().accountId,
        vaultId: billingContext().vaultId,
      },
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

function cancelRunningSnapshot(): AccountDeletionSnapshot {
  const revokeClaim = claim(newOperation(), 1_000);
  if (revokeClaim.next.state.kind !== 'running') {
    throw new Error('invalid revoke claim fixture');
  }
  const revokeSuccess = planAccountDeletionStepResult({
    operation: revokeClaim.next,
    result: {
      kind: 'succeeded',
      step: 'revoke-sessions',
      attempt: revokeClaim.next.state.attempt,
      finishedAt: 1_100,
    },
    retryPolicy: { delaysMs: [100] },
  });
  if (
    revokeSuccess.kind !== 'accepted' ||
    revokeSuccess.transition.receipt === undefined
  ) {
    throw new Error('invalid revoke success fixture');
  }
  return {
    operation: claim(revokeSuccess.transition.next, 1_100).next,
    receipts: [revokeSuccess.transition.receipt],
  };
}
