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
      actions: ['cancelled'],
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
      status: 'cancelled',
      outcome: 'cancelled',
      confirmedAt: 10_000,
    });
    expect(provider.cancellationSideEffectCount()).toBe(1);
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
