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
  subscriptionCancelledFact,
  trialStartedFact,
} from '@/tests/fixtures/billing';

describe('subscription cancellation service', () => {
  it('confirms an immediate provider cancellation without exposing its reference', async () => {
    const billing = await mappedBilling();
    const provider = createFakeSubscriptionCancellationProvider({
      actions: ['cancelled'],
    });
    const port = createSubscriptionCancellationPort({
      repository: billing.repository,
      provider,
    });
    await expect(port.cancelSubscription(command())).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'cancelled',
      confirmedAt: 10_000,
    });
    expect(provider.commands()).toHaveLength(1);
    expect(provider.cancellationSideEffectCount()).toBe(1);
    expect(Object.keys(await port.cancelSubscription(command()))).not.toContain(
      'providerSubscriptionReference',
    );
  });

  it('retries a lost response with one idempotency key and one provider side effect', async () => {
    const billing = await mappedBilling();
    const provider = createFakeSubscriptionCancellationProvider({
      actions: ['cancelled-response-lost'],
    });
    const port = createSubscriptionCancellationPort({
      repository: billing.repository,
      provider,
    });
    await expect(port.cancelSubscription(command())).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'provider-unavailable',
    });
    await expect(port.cancelSubscription(command())).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'already-cancelled',
      confirmedAt: 10_000,
    });
    expect(provider.cancellationSideEffectCount()).toBe(1);
    expect(
      provider.commands().map((request) => request.idempotencyKey),
    ).toEqual([command().idempotencyKey, command().idempotencyKey]);
  });

  it('recovers from a retryable result but does not accept malformed or out-of-order results', async () => {
    const billing = await mappedBilling();
    const provider = createFakeSubscriptionCancellationProvider({
      actions: ['retryable-failure', 'cancelled'],
    });
    const port = createSubscriptionCancellationPort({
      repository: billing.repository,
      provider,
    });
    await expect(port.cancelSubscription(command())).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'provider-unavailable',
    });
    await expect(port.cancelSubscription(command())).resolves.toMatchObject({
      kind: 'confirmed',
      outcome: 'cancelled',
    });

    const malformed = createFakeSubscriptionCancellationProvider({
      actions: ['malformed'],
    });
    await expect(
      createSubscriptionCancellationPort({
        repository: billing.repository,
        provider: malformed,
      }).cancelSubscription(command()),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'malformed-provider-response',
    });

    const outOfOrder = createFakeSubscriptionCancellationProvider({
      actions: ['out-of-order'],
    });
    await expect(
      createSubscriptionCancellationPort({
        repository: billing.repository,
        provider: outOfOrder,
      }).cancelSubscription(command()),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'provider-result-mismatch',
    });
  });

  it('keeps provider terminal and unavailability distinct from confirmation', async () => {
    for (const [action, expected] of [
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
        }).cancelSubscription(command()),
      ).resolves.toEqual(expected);
      expect(provider.cancellationSideEffectCount()).toBe(0);
    }
  });

  it('confirms an already-cancelled aggregate and rejects another Account before the provider', async () => {
    const billing = await mappedBilling();
    await billing.api.ingestVerifiedProviderFact(subscriptionCancelledFact());
    const provider = createFakeSubscriptionCancellationProvider({
      actions: [],
    });
    const port = createSubscriptionCancellationPort({
      repository: billing.repository,
      provider,
    });
    await expect(port.cancelSubscription(command())).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'already-cancelled',
      confirmedAt: 9_000,
    });
    await expect(
      port.cancelSubscription({
        ...command(),
        accountId: billingContext('b').accountId,
        vaultId: billingContext('b').vaultId,
      }),
    ).resolves.toEqual({
      kind: 'terminal-failure',
      reason: 'subscription-not-found',
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

async function mappedBilling() {
  const billing = createFakeBillingModule([
    billingContext(),
    billingContext('b'),
  ]);
  await billing.api.beginCheckout(billingContext(), beginCheckoutCommand());
  await billing.api.ingestVerifiedProviderFact(trialStartedFact());
  return billing;
}
