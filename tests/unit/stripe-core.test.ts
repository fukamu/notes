import { describe, expect, it } from 'vitest';
import {
  decodeStripeCheckoutResponse,
  decodeStripeEventPlan,
  decodeStripeReconciliationSnapshot,
  planStripeCheckout,
} from '@/server/stripe/core';
import {
  STRIPE_API_VERSION,
  parseStripeBillingConfiguration,
} from '@/server/stripe/public';
import { billingIds } from '@/tests/fixtures/billing';
import {
  stripeCheckoutCompletedObject,
  stripeCheckoutMetadata,
  stripeCheckoutResponse,
  stripeConfiguration,
  stripeEvent,
  stripeIds,
  stripeInvoiceObject,
  stripeHostedCheckoutCommand,
  stripeSetupIntentSucceededObject,
  stripeSubscriptionObject,
  stripeSubscriptionSnapshot,
} from '@/tests/fixtures/stripe';

describe('Stripe adapter pure core', () => {
  it('fixes subscription mode, payment-method collection, and the 14-day trial', () => {
    const hostedCheckout = stripeHostedCheckoutCommand();
    const command = planStripeCheckout(stripeConfiguration, hostedCheckout);
    expect(command).toMatchObject({
      apiVersion: STRIPE_API_VERSION,
      idempotencyKey: billingIds.checkoutA,
    });
    const fields = new Map(command.fields);
    expect(fields.get('mode')).toBe('subscription');
    expect(fields.get('submit_type')).toBe('subscribe');
    expect(fields.get('payment_method_collection')).toBe('always');
    expect(
      fields.get('payment_method_options[card][request_three_d_secure]'),
    ).toBe('any');
    expect(fields.get('subscription_data[trial_period_days]')).toBe('14');
    expect(
      fields.get(
        'subscription_data[trial_settings][end_behavior][missing_payment_method]',
      ),
    ).toBe('cancel');
    expect(fields.get('line_items[0][quantity]')).toBe('1');
    expect(fields.get('metadata[billing_subscription_id]')).toBe(
      billingIds.subscriptionA,
    );
    expect(fields.get('metadata[contract_evidence_id]')).toBe(
      hostedCheckout.contract.evidenceId,
    );
    expect(fields.get('metadata[contract_offer_hash]')).toBe(
      hostedCheckout.contract.offerHash,
    );
    expect(fields.get('custom_text[submit][message]')).toContain('14日間は0円');
    expect(
      fields.get('custom_text[submit][message]')?.length,
    ).toBeLessThanOrEqual(1_200);
  });

  it('accepts HTTPS and loopback development callbacks but rejects insecure remote callbacks', () => {
    expect(
      parseStripeBillingConfiguration({
        ...stripeConfiguration,
        successUrl: 'http://localhost:3000/billing/success',
        cancelUrl: 'http://127.0.0.1:3000/billing/cancel',
      }),
    ).toMatchObject({ mode: 'test' });
    expect(() =>
      parseStripeBillingConfiguration({
        ...stripeConfiguration,
        successUrl: 'http://notes.example.test/success',
      }),
    ).toThrow(/Stripe Billing configuration failed validation/);
    expect(() =>
      parseStripeBillingConfiguration({
        ...stripeConfiguration,
        apiVersion: 'latest',
      }),
    ).toThrow(/Stripe Billing configuration failed validation/);
  });

  it('decodes only the expected Checkout mapping and Stripe-hosted redirect', () => {
    const expected = {
      mode: 'test',
      ...stripeHostedCheckoutCommand(),
    } as const;
    expect(
      decodeStripeCheckoutResponse(stripeCheckoutResponse(), expected),
    ).toEqual({
      kind: 'accepted',
      response: {
        providerCheckoutReference: stripeIds.checkout,
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_FukamuA',
      },
    });
    expect(
      decodeStripeCheckoutResponse(
        stripeCheckoutResponse({
          metadata: stripeCheckoutMetadata({
            billing_subscription_id: billingIds.subscriptionB,
          }),
        }),
        expected,
      ),
    ).toEqual({ kind: 'rejected', reason: 'provider-mapping-mismatch' });
    expect(
      decodeStripeCheckoutResponse(
        stripeCheckoutResponse({ url: 'https://example.test/not-stripe' }),
        expected,
      ),
    ).toEqual({ kind: 'rejected', reason: 'malformed-provider-response' });
  });

  it('maps official-format Checkout, invoice, SetupIntent, and cancellation events', () => {
    const checkout = decodeStripeEventPlan(
      stripeEvent(
        'checkout.session.completed',
        stripeCheckoutCompletedObject(),
      ),
      expectedEvent(),
    );
    expect(checkout).toMatchObject({
      kind: 'snapshot',
      plan: {
        subscriptionId: billingIds.subscriptionA,
        providerSubscriptionReference: stripeIds.subscription,
      },
    });

    const paid = decodeStripeEventPlan(
      stripeEvent(
        'invoice.paid',
        stripeInvoiceObject({ paid: true, status: 'paid' }),
        { id: 'evt_invoice_paid_A', created: 5 },
      ),
      expectedEvent(5_100),
    );
    expect(paid).toMatchObject({
      kind: 'fact',
      fact: {
        kind: 'invoice-paid',
        invoiceReference: stripeIds.invoice1,
        occurredAt: 5_000,
      },
    });

    const actionRequired = decodeStripeEventPlan(
      stripeEvent(
        'invoice.payment_action_required',
        stripeInvoiceObject({ paid: false, status: 'open' }),
        { id: 'evt_invoice_action_A', created: 5 },
      ),
      expectedEvent(5_100),
    );
    expect(actionRequired).toMatchObject({
      kind: 'fact',
      fact: { kind: 'invoice-payment-action-required' },
    });

    const setup = decodeStripeEventPlan(
      stripeEvent(
        'setup_intent.succeeded',
        stripeSetupIntentSucceededObject(),
        { id: 'evt_setup_A', created: 6 },
      ),
      expectedEvent(6_100),
    );
    expect(setup).toMatchObject({
      kind: 'fact',
      fact: { kind: 'payment-method-updated' },
    });

    const scheduled = decodeStripeEventPlan(
      stripeEvent(
        'customer.subscription.updated',
        stripeSubscriptionObject({ cancelAt: 20 }),
        { id: 'evt_cancel_A', created: 8 },
      ),
      expectedEvent(8_100),
    );
    expect(scheduled).toMatchObject({
      kind: 'fact',
      fact: { kind: 'cancellation-scheduled', cancelAt: 20_000 },
    });

    const deleted = decodeStripeEventPlan(
      stripeEvent(
        'customer.subscription.deleted',
        stripeSubscriptionObject({ status: 'canceled', endedAt: 9 }),
        { id: 'evt_deleted_A', created: 9 },
      ),
      expectedEvent(9_100),
    );
    expect(deleted).toMatchObject({
      kind: 'fact',
      fact: { kind: 'subscription-cancelled', cancelledAt: 9_000 },
    });
  });

  it('fails closed on event mode/version mismatch and malformed invoice claims', () => {
    expect(
      decodeStripeEventPlan(
        stripeEvent(
          'invoice.paid',
          stripeInvoiceObject({ paid: true, status: 'paid' }),
          {
            livemode: true,
          },
        ),
        expectedEvent(),
      ),
    ).toEqual({ kind: 'rejected', reason: 'runtime-mode-mismatch' });
    expect(
      decodeStripeEventPlan(
        stripeEvent(
          'invoice.paid',
          stripeInvoiceObject({ paid: true, status: 'paid' }),
          {
            apiVersion: '2024-06-20',
          },
        ),
        expectedEvent(),
      ),
    ).toEqual({ kind: 'rejected', reason: 'api-version-mismatch' });
    expect(
      decodeStripeEventPlan(
        stripeEvent(
          'invoice.paid',
          stripeInvoiceObject({ paid: false, status: 'open' }),
        ),
        expectedEvent(),
      ),
    ).toEqual({ kind: 'rejected', reason: 'malformed-event' });
  });

  it('requires a succeeded off-session SetupIntent before projecting a trial', () => {
    const plan = snapshotPlan();
    expect(
      decodeStripeReconciliationSnapshot(stripeSubscriptionSnapshot(), plan),
    ).toMatchObject({
      paymentMethodReady: true,
      trial: { startedAt: 2_000, endsAt: 1_209_602_000 },
    });
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({ setupStatus: 'requires_action' }),
        plan,
      ),
    ).toBeUndefined();
  });

  it('maps paid and delinquent snapshots while rejecting provider mapping mismatch', () => {
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({
          invoicePaid: true,
          invoiceStatus: 'paid',
        }),
        snapshotPlan(8_000),
      ),
    ).toMatchObject({
      latestPaidInvoice: {
        invoiceReference: stripeIds.invoice1,
        paidAt: 3_000,
      },
      delinquency: null,
    });
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({ paymentIntentStatus: 'requires_action' }),
        snapshotPlan(9_000),
      ),
    ).toMatchObject({
      delinquency: {
        reason: 'payment-action-required',
        invoiceReference: stripeIds.invoice1,
        occurredAt: 2_000,
      },
    });
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({
          billingSubscriptionId: billingIds.subscriptionB,
        }),
        snapshotPlan(),
      ),
    ).toBeUndefined();
  });

  it('rejects missing, inconsistent, and future provider evidence times', () => {
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({
          invoicePaid: true,
          invoiceStatus: 'paid',
          invoicePaidAt: null,
        }),
        snapshotPlan(8_000),
      ),
    ).toBeUndefined();
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({ invoicePaidAt: 3 }),
        snapshotPlan(8_000),
      ),
    ).toBeUndefined();
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({ subscriptionCreated: 10 }),
        snapshotPlan(9_000),
      ),
    ).toBeUndefined();
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({ invoiceCreated: 10 }),
        snapshotPlan(9_000),
      ),
    ).toBeUndefined();
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({
          invoicePaid: true,
          invoiceStatus: 'paid',
          invoicePaidAt: 9,
        }),
        snapshotPlan(8_000),
      ),
    ).toBeUndefined();
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({
          invoiceCreated: 3,
          paymentIntentStatus: 'requires_action',
          paymentIntentCreated: 2,
        }),
        snapshotPlan(9_000),
      ),
    ).toBeUndefined();
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({
          paymentIntentStatus: 'requires_action',
          paymentIntentCreated: 10,
        }),
        snapshotPlan(9_000),
      ),
    ).toBeUndefined();
    expect(
      decodeStripeReconciliationSnapshot(
        stripeSubscriptionSnapshot({ setupCreated: 10 }),
        snapshotPlan(9_000),
      ),
    ).toBeUndefined();
  });
});

function expectedEvent(receivedAt = 3_000) {
  return {
    mode: 'test',
    apiVersion: STRIPE_API_VERSION,
    receivedAt,
  } as const;
}

function snapshotPlan(observedAt = 3_000) {
  return {
    snapshotId: stripeIds.snapshot,
    subscriptionId: billingIds.subscriptionA,
    providerSubscriptionReference: stripeIds.subscription,
    observedAt,
    recordedAt: observedAt + 100,
  } as const;
}
