import { describe, expect, it } from 'vitest';
import { createSubscriptionCancellationPort } from '@/server/billing/cancellation-service';
import { createFakeSubscriptionCancellationProvider } from '@/server/billing/fake-cancellation';
import { createFakeBillingModule } from '@/server/billing/fake';
import {
  parseSubscriptionCancellationIdempotencyKey,
  type SubscriptionCancellationCommand,
} from '@/server/billing/public';
import {
  beginCheckoutCommand,
  billingContext,
  invoicePaidFact,
  subscriptionCancelledFact,
  trialStartedFact,
} from '@/tests/fixtures/billing';

describe('subscription cancellation service', () => {
  it('schedules trial and paid subscriptions at the provider-confirmed period end', async () => {
    for (const phase of ['trial', 'paid'] as const) {
      const billing = await mappedBilling(phase);
      const accessEndsAt = phase === 'trial' ? 20_000 : 30_000;
      const provider = createFakeSubscriptionCancellationProvider({
        actions: ['scheduled'],
        scheduledAccessEndsAt: accessEndsAt,
      });
      const port = createSubscriptionCancellationPort({
        repository: billing.repository,
        provider,
      });
      await expect(
        port.scheduleSubscriptionCancellation(command()),
      ).resolves.toEqual({
        kind: 'confirmed',
        outcome: 'scheduled',
        confirmedAt: 10_000,
        accessEndsAt,
      });
      expect(provider.commands()).toMatchObject([{ effect: 'period-end' }]);
      expect(provider.cancellationSideEffectCount()).toBe(1);
    }
  });

  it('uses a separate immediate provider effect for account deletion', async () => {
    const billing = await mappedBilling();
    const provider = createFakeSubscriptionCancellationProvider({
      actions: ['cancelled'],
    });
    const port = createSubscriptionCancellationPort({
      repository: billing.repository,
      provider,
    });
    await expect(
      port.cancelSubscriptionImmediately(command()),
    ).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'cancelled',
      confirmedAt: 10_000,
      accessEndsAt: 10_000,
    });
    expect(provider.commands()).toMatchObject([{ effect: 'immediate' }]);
  });

  it('retries a lost period-end response with one idempotency key and one provider side effect', async () => {
    const billing = await mappedBilling();
    const provider = createFakeSubscriptionCancellationProvider({
      actions: ['scheduled-response-lost'],
      scheduledAccessEndsAt: 20_000,
    });
    const port = createSubscriptionCancellationPort({
      repository: billing.repository,
      provider,
    });
    await expect(
      port.scheduleSubscriptionCancellation(command()),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'provider-unavailable',
    });
    await expect(
      port.scheduleSubscriptionCancellation({
        ...command(),
        requestedAt: 11_000,
      }),
    ).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'scheduled',
      confirmedAt: 10_000,
      accessEndsAt: 20_000,
    });
    expect(provider.cancellationSideEffectCount()).toBe(1);
    expect(
      provider.commands().map((request) => request.idempotencyKey),
    ).toEqual([command().idempotencyKey, command().idempotencyKey]);
  });

  it('does not treat an immediate result as normal period-end completion or a schedule as deletion completion', async () => {
    const billing = await mappedBilling();
    const immediateProvider = createFakeSubscriptionCancellationProvider({
      actions: ['cancelled'],
    });
    await expect(
      createSubscriptionCancellationPort({
        repository: billing.repository,
        provider: immediateProvider,
      }).scheduleSubscriptionCancellation(command()),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'provider-result-mismatch',
    });

    const scheduledProvider = createFakeSubscriptionCancellationProvider({
      actions: ['scheduled'],
      scheduledAccessEndsAt: 20_000,
    });
    await expect(
      createSubscriptionCancellationPort({
        repository: billing.repository,
        provider: scheduledProvider,
      }).cancelSubscriptionImmediately(command()),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'provider-result-mismatch',
    });
  });

  it('keeps retryable, malformed, out-of-order, terminal, and unavailable provider results distinct', async () => {
    for (const [action, expected] of [
      [
        'retryable-failure',
        { kind: 'retryable-failure', reason: 'provider-unavailable' },
      ],
      [
        'malformed',
        { kind: 'retryable-failure', reason: 'malformed-provider-response' },
      ],
      [
        'out-of-order',
        { kind: 'retryable-failure', reason: 'provider-result-mismatch' },
      ],
      [
        'terminal-failure',
        { kind: 'terminal-failure', reason: 'provider-terminal' },
      ],
      [
        'unavailable',
        { kind: 'retryable-failure', reason: 'provider-unavailable' },
      ],
    ] as const) {
      const billing = await mappedBilling();
      const provider = createFakeSubscriptionCancellationProvider({
        actions: [action],
      });
      await expect(
        createSubscriptionCancellationPort({
          repository: billing.repository,
          provider,
        }).cancelSubscriptionImmediately(command()),
      ).resolves.toEqual(expected);
    }
  });

  it('confirms an already-cancelled aggregate without another provider effect', async () => {
    const billing = await mappedBilling();
    await billing.api.ingestVerifiedProviderFact(subscriptionCancelledFact());
    const provider = createFakeSubscriptionCancellationProvider({
      actions: [],
    });
    const port = createSubscriptionCancellationPort({
      repository: billing.repository,
      provider,
    });
    await expect(
      port.scheduleSubscriptionCancellation(command()),
    ).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'already-cancelled',
      confirmedAt: 9_000,
      accessEndsAt: 9_000,
    });
    await expect(
      port.cancelSubscriptionImmediately(command()),
    ).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'already-cancelled',
      confirmedAt: 9_000,
      accessEndsAt: 9_000,
    });
    expect(provider.commands()).toEqual([]);
  });
});

function command(): SubscriptionCancellationCommand {
  return {
    accountId: billingContext().accountId,
    vaultId: billingContext().vaultId,
    idempotencyKey: parseSubscriptionCancellationIdempotencyKey(
      '01991f20-61d2-7000-8000-000000000801',
    ),
    requestedAt: 10_000,
  };
}

async function mappedBilling(phase: 'trial' | 'paid' = 'trial') {
  const billing = createFakeBillingModule([
    billingContext(),
    billingContext('b'),
  ]);
  await billing.api.beginCheckout(billingContext(), beginCheckoutCommand());
  await billing.api.ingestVerifiedProviderFact(trialStartedFact());
  if (phase === 'paid') {
    await billing.api.ingestVerifiedProviderFact(invoicePaidFact());
  }
  return billing;
}
