import { describe, expect, it } from 'vitest';
import { createSubscriptionCancellationHandler } from '@/app/api/billing/cancel/handler';
import { createSubscriptionCancellationPort } from '@/server/billing/cancellation-service';
import { createFakeSubscriptionCancellationProvider } from '@/server/billing/fake-cancellation';
import { createFakeBillingModule } from '@/server/billing/fake';
import { parseSubscriptionCancellationIdempotencyKey } from '@/server/billing/public';
import { createActiveSession } from '@/server/core/session';
import {
  beginCheckoutCommand,
  billingContext,
  paymentFailedFact,
  trialStartedFact,
} from '@/tests/fixtures/billing';
import { cookieHeader } from '@/tests/fixtures/session';

describe('locked subscription cancellation HTTP integration', () => {
  it('allows cancellation while Notes access is payment-failure locked', async () => {
    const billing = createFakeBillingModule([billingContext()]);
    await billing.api.beginCheckout(billingContext(), beginCheckoutCommand());
    await billing.api.ingestVerifiedProviderFact(trialStartedFact());
    await billing.api.ingestVerifiedProviderFact(paymentFailedFact());
    await expect(
      billing.api.readSubscription(billingContext()),
    ).resolves.toMatchObject({
      lifecycle: { kind: 'delinquent', reason: 'payment-failed' },
    });

    const provider = createFakeSubscriptionCancellationProvider({
      actions: ['scheduled'],
      scheduledAccessEndsAt: 20_000,
    });
    const handler = createSubscriptionCancellationHandler({
      expectedOrigin: 'https://notes.example',
      clock: { now: () => 10_000 },
      sessions: {
        findSessionByToken: async () => lockedSession(),
      },
      cancellation: createSubscriptionCancellationPort({
        repository: billing.repository,
        provider,
      }),
    });
    const response = await handler(
      new Request('https://notes.example/api/billing/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader(),
          origin: 'https://notes.example',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({
          idempotencyKey:
            parseSubscriptionCancellationIdempotencyKey('cancel_locked_A'),
        }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: 'cancellation-scheduled',
      outcome: 'scheduled',
      confirmedAt: 10_000,
      accessEndsAt: 20_000,
    });
    expect(provider.cancellationSideEffectCount()).toBe(1);
    expect(provider.commands()).toMatchObject([{ effect: 'period-end' }]);
  });

  it('recovers a lost provider response with the same key after the server clock advances', async () => {
    const billing = createFakeBillingModule([billingContext()]);
    await billing.api.beginCheckout(billingContext(), beginCheckoutCommand());
    await billing.api.ingestVerifiedProviderFact(trialStartedFact());

    const provider = createFakeSubscriptionCancellationProvider({
      actions: ['scheduled-response-lost'],
      scheduledAccessEndsAt: 20_000,
    });
    let now = 10_000;
    const handler = createSubscriptionCancellationHandler({
      expectedOrigin: 'https://notes.example',
      clock: {
        now: () => {
          const result = now;
          now += 1_000;
          return result;
        },
      },
      sessions: {
        findSessionByToken: async () => lockedSession(),
      },
      cancellation: createSubscriptionCancellationPort({
        repository: billing.repository,
        provider,
      }),
    });
    const cancellationRequest = () =>
      new Request('https://notes.example/api/billing/cancel', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: cookieHeader(),
          origin: 'https://notes.example',
          'sec-fetch-site': 'same-origin',
        },
        body: JSON.stringify({
          idempotencyKey:
            parseSubscriptionCancellationIdempotencyKey('cancel_retry_A'),
        }),
      });

    const first = await handler(cancellationRequest());
    expect(first.status).toBe(503);

    const second = await handler(cancellationRequest());
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toEqual({
      status: 'cancellation-scheduled',
      outcome: 'scheduled',
      confirmedAt: 10_000,
      accessEndsAt: 20_000,
    });
    expect(provider.cancellationSideEffectCount()).toBe(1);
    expect(provider.commands().map((command) => command.requestedAt)).toEqual([
      10_000, 11_000,
    ]);
  });
});

function lockedSession() {
  const context = billingContext();
  const decision = createActiveSession({
    sessionId: context.sessionId,
    accountId: context.accountId,
    vaultId: context.vaultId,
    sessionEpoch: context.sessionEpoch,
    issuedAt: 1_000,
    expiresAt: 20_000,
  });
  if (decision.kind === 'rejected') throw new Error('invalid session fixture');
  return decision.session;
}
