import { describe, expect, it, vi } from 'vitest';
import { createFakeBillingModule } from '@/server/billing/fake';
import {
  createFakeStripeTransport,
  createFakeStripeWebhookVerifier,
} from '@/server/stripe/fake';
import { createStripeBillingAdapter } from '@/server/stripe/service';
import type { StripeTransportPort } from '@/server/stripe/ports';
import { billingContext, billingIds } from '@/tests/fixtures/billing';
import {
  containsSensitiveMarker,
  securityCorpusMarker,
} from '@/tests/fixtures/security-corpus';
import {
  stripeCheckoutCompletedObject,
  stripeCheckoutResponse,
  stripeConfiguration,
  stripeEvent,
  stripeHostedCheckoutCommand,
  stripeIds,
  stripeInvoiceObject,
  stripeSubscriptionSnapshot,
  stripeWebhookBody,
} from '@/tests/fixtures/stripe';

describe('Stripe Billing adapter with fake provider boundary', () => {
  it('creates a fixed Checkout request and records the provider redirect mapping', async () => {
    const setup = testAdapter();
    await expect(
      setup.adapter.beginHostedCheckout(billingContext(), checkoutCommand()),
    ).resolves.toEqual({
      kind: 'redirect',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_FukamuA',
      providerCheckoutReference: stripeIds.checkout,
    });
    expect(setup.transport.checkoutCommands()).toHaveLength(1);
    expect(setup.billing.repository.inspect().checkoutIntents[0]).toMatchObject(
      {
        providerCheckoutReference: stripeIds.checkout,
        status: 'opened',
      },
    );
  });

  it('recovers a lost provider response with the same Checkout idempotency key', async () => {
    const setup = testAdapter({ loseFirstCheckoutResponse: true });
    await expect(
      setup.adapter.beginHostedCheckout(billingContext(), checkoutCommand()),
    ).resolves.toEqual({ kind: 'rejected', reason: 'provider-unavailable' });
    await expect(
      setup.adapter.beginHostedCheckout(billingContext(), checkoutCommand()),
    ).resolves.toMatchObject({ kind: 'redirect' });
    expect(
      setup.transport.checkoutCommands().map((item) => item.idempotencyKey),
    ).toEqual([billingIds.checkoutA, billingIds.checkoutA]);
    expect(setup.billing.repository.inspect().subscriptions).toHaveLength(1);
  });

  it('verifies Checkout completion through a provider snapshot and deduplicates replay', async () => {
    const setup = testAdapter();
    await setup.adapter.beginHostedCheckout(
      billingContext(),
      checkoutCommand(),
    );
    const event = stripeEvent(
      'checkout.session.completed',
      stripeCheckoutCompletedObject(),
    );
    await expect(
      setup.adapter.ingestWebhook(webhook(event, 3_000)),
    ).resolves.toEqual({
      kind: 'accepted',
      outcome: 'applied',
    });
    await expect(
      setup.adapter.ingestWebhook(webhook(event, 3_000)),
    ).resolves.toEqual({
      kind: 'accepted',
      outcome: 'duplicate',
    });
    expect(setup.transport.snapshotRequests()).toHaveLength(2);
    await expect(
      setup.billing.api.readSubscription(billingContext()),
    ).resolves.toMatchObject({
      lifecycle: { kind: 'trialing' },
      paymentMethodReady: true,
    });
  });

  it('reconciles an explicitly retrieved provider snapshot idempotently', async () => {
    const setup = testAdapter();
    await setup.adapter.beginHostedCheckout(
      billingContext(),
      checkoutCommand(),
    );
    const command = {
      snapshotId: stripeIds.snapshot,
      subscriptionId: billingIds.subscriptionA,
      providerSubscriptionReference: stripeIds.subscription,
      observedAt: 3_000,
      recordedAt: 3_100,
    } as const;
    await expect(setup.adapter.reconcileSubscription(command)).resolves.toEqual(
      {
        kind: 'accepted',
        outcome: 'applied',
      },
    );
    await expect(setup.adapter.reconcileSubscription(command)).resolves.toEqual(
      {
        kind: 'accepted',
        outcome: 'duplicate',
      },
    );
  });

  it('keeps a newer failure when an older paid event arrives out of order', async () => {
    const setup = await startedTrial();
    const failed = stripeEvent(
      'invoice.payment_failed',
      stripeInvoiceObject({ paid: false, status: 'open' }),
      { id: 'evt_failed_newer', created: 7 },
    );
    const olderPaid = stripeEvent(
      'invoice.paid',
      stripeInvoiceObject({
        id: stripeIds.invoice2,
        paid: true,
        status: 'paid',
      }),
      { id: 'evt_paid_older', created: 6 },
    );
    await expect(
      setup.adapter.ingestWebhook(webhook(failed, 7_100)),
    ).resolves.toEqual({
      kind: 'accepted',
      outcome: 'applied',
    });
    await expect(
      setup.adapter.ingestWebhook(webhook(olderPaid, 7_200)),
    ).resolves.toEqual({
      kind: 'accepted',
      outcome: 'applied',
    });
    await expect(
      setup.billing.api.readSubscription(billingContext()),
    ).resolves.toMatchObject({
      lifecycle: { kind: 'delinquent', reason: 'payment-failed' },
    });
  });

  it('rejects invalid signatures, malformed provider snapshots, and mapping mismatch', async () => {
    const invalidSignature = testAdapter();
    await expect(
      invalidSignature.adapter.ingestWebhook({
        ...webhook(
          stripeEvent(
            'checkout.session.completed',
            stripeCheckoutCompletedObject(),
          ),
          3_000,
        ),
        signatureHeader: 'forged',
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'invalid-signature' });

    const malformed = testAdapter({
      snapshot: stripeSubscriptionSnapshot({ setupStatus: 'requires_action' }),
    });
    await malformed.adapter.beginHostedCheckout(
      billingContext(),
      checkoutCommand(),
    );
    await expect(
      malformed.adapter.ingestWebhook(
        webhook(
          stripeEvent(
            'checkout.session.completed',
            stripeCheckoutCompletedObject(),
          ),
          3_000,
        ),
      ),
    ).resolves.toEqual({ kind: 'rejected', reason: 'malformed-event' });

    const mismatch = testAdapter();
    await mismatch.adapter.beginHostedCheckout(
      billingContext(),
      checkoutCommand(),
    );
    await expect(
      mismatch.adapter.ingestWebhook(
        webhook(
          stripeEvent(
            'invoice.paid',
            stripeInvoiceObject({
              paid: true,
              status: 'paid',
              subscriptionId: billingIds.subscriptionB,
            }),
            { created: 5 },
          ),
          5_100,
        ),
      ),
    ).resolves.toEqual({ kind: 'rejected', reason: 'billing-rejected' });
  });

  it('fails closed across provider timeout and malformed snapshot, then retries the same event safely', async () => {
    const billing = createFakeBillingModule([billingContext()]);
    const baseTransport = createFakeStripeTransport({
      checkoutResponse: stripeCheckoutResponse(),
      snapshots: new Map([
        [stripeIds.subscription, stripeSubscriptionSnapshot()],
      ]),
    });
    const failure = new Error(`timeout:${securityCorpusMarker}`);
    failure.name = `provider:${securityCorpusMarker}`;
    let retrievals = 0;
    const transport: StripeTransportPort = {
      createCheckoutSession: (command) =>
        baseTransport.createCheckoutSession(command),
      async retrieveSubscriptionSnapshot(request) {
        retrievals += 1;
        if (retrievals === 1) throw failure;
        if (retrievals === 2) {
          return { malformed: securityCorpusMarker };
        }
        return baseTransport.retrieveSubscriptionSnapshot(request);
      },
    };
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const adapter = createStripeBillingAdapter({
      configuration: stripeConfiguration,
      billing: billing.api,
      transport,
      webhookVerifier: createFakeStripeWebhookVerifier(),
    });
    await adapter.beginHostedCheckout(billingContext(), checkoutCommand());
    const event = webhook(
      stripeEvent(
        'checkout.session.completed',
        stripeCheckoutCompletedObject(),
      ),
      3_000,
    );

    await expect(adapter.ingestWebhook(event)).resolves.toEqual({
      kind: 'rejected',
      reason: 'provider-unavailable',
    });
    await expect(adapter.ingestWebhook(event)).resolves.toEqual({
      kind: 'rejected',
      reason: 'malformed-event',
    });
    expect(billing.repository.inspect().reconciliationCheckpoints).toEqual([]);
    await expect(
      billing.api.readSubscription(billingContext()),
    ).resolves.toMatchObject({ lifecycle: { kind: 'checkout-pending' } });

    await expect(adapter.ingestWebhook(event)).resolves.toEqual({
      kind: 'accepted',
      outcome: 'applied',
    });
    await expect(adapter.ingestWebhook(event)).resolves.toEqual({
      kind: 'accepted',
      outcome: 'duplicate',
    });
    expect(retrievals).toBe(4);
    expect(log).not.toHaveBeenCalled();
    expect(
      containsSensitiveMarker(log.mock.calls, [securityCorpusMarker]),
    ).toBe(false);
  });
});

function testAdapter(
  options: {
    readonly loseFirstCheckoutResponse?: boolean;
    readonly snapshot?: unknown;
  } = {},
) {
  const billing = createFakeBillingModule([billingContext()]);
  const transport = createFakeStripeTransport({
    checkoutResponse: stripeCheckoutResponse(),
    snapshots: new Map([
      [
        stripeIds.subscription,
        options.snapshot ?? stripeSubscriptionSnapshot(),
      ],
    ]),
    ...(options.loseFirstCheckoutResponse === undefined
      ? {}
      : { loseFirstCheckoutResponse: options.loseFirstCheckoutResponse }),
  });
  return {
    billing,
    transport,
    adapter: createStripeBillingAdapter({
      configuration: stripeConfiguration,
      billing: billing.api,
      transport,
      webhookVerifier: createFakeStripeWebhookVerifier(),
    }),
  };
}

async function startedTrial() {
  const setup = testAdapter();
  await setup.adapter.beginHostedCheckout(billingContext(), checkoutCommand());
  await setup.adapter.ingestWebhook(
    webhook(
      stripeEvent(
        'checkout.session.completed',
        stripeCheckoutCompletedObject(),
      ),
      3_000,
    ),
  );
  return setup;
}

function checkoutCommand() {
  return stripeHostedCheckoutCommand();
}

function webhook(event: unknown, receivedAt: number) {
  return {
    rawBody: stripeWebhookBody(event),
    signatureHeader: 'fake-stripe-signature',
    receivedAt,
  } as const;
}
