import { describe, expect, it } from 'vitest';
import { createFakeBillingModule } from '@/server/billing/fake';
import { createFakeEntitlementModule } from '@/server/entitlement/fake';
import {
  createFakeStripeTransport,
  createFakeStripeWebhookVerifier,
} from '@/server/stripe/fake';
import { createStripeBillingAdapter } from '@/server/stripe/service';
import { billingContext, billingIds } from '@/tests/fixtures/billing';
import { undecidedOfflineLeasePolicy } from '@/tests/fixtures/entitlement';
import {
  stripeCheckoutCompletedObject,
  stripeCheckoutResponse,
  stripeConfiguration,
  stripeEvent,
  stripeIds,
  stripeInvoiceObject,
  stripeSetupIntentSucceededObject,
  stripeSubscriptionSnapshot,
  stripeWebhookBody,
} from '@/tests/fixtures/stripe';

describe('Stripe to Billing to Entitlement integration', () => {
  it.each([
    ['invoice.payment_failed', 'payment-failed'],
    ['invoice.payment_action_required', 'payment-action-required'],
  ] as const)(
    'grants trial only after verified setup and resumes %s only after invoice.paid',
    async (delinquencyEvent, expectedLockReason) => {
      const billing = createFakeBillingModule([billingContext()]);
      const entitlement = createFakeEntitlementModule({
        owners: [billingContext()],
        billing: billing.api,
        offlineLeasePolicy: undecidedOfflineLeasePolicy,
      });
      const stripe = createStripeBillingAdapter({
        configuration: stripeConfiguration,
        billing: billing.api,
        transport: createFakeStripeTransport({
          checkoutResponse: stripeCheckoutResponse(),
          snapshots: new Map([
            [stripeIds.subscription, stripeSubscriptionSnapshot()],
          ]),
        }),
        webhookVerifier: createFakeStripeWebhookVerifier(),
      });

      await stripe.beginHostedCheckout(billingContext(), {
        subscriptionId: billingIds.subscriptionA,
        checkoutIntentId: billingIds.checkoutA,
        createdAt: 1_000,
      });
      await expect(
        entitlement.port.authorizeCapability(
          billingContext(),
          'notes-read',
          1_500,
        ),
      ).resolves.toMatchObject({
        kind: 'denied',
        reason: 'payment-method-required',
      });

      await stripe.ingestWebhook(
        webhook(
          stripeEvent(
            'checkout.session.completed',
            stripeCheckoutCompletedObject(),
          ),
          3_000,
        ),
      );
      await expect(
        entitlement.port.authorizeCapability(
          billingContext(),
          'notes-write',
          3_100,
        ),
      ).resolves.toMatchObject({ kind: 'allowed', basis: 'trial' });

      const failedWebhook = webhook(
        stripeEvent(
          delinquencyEvent,
          stripeInvoiceObject({ paid: false, status: 'open' }),
          { id: `evt_${delinquencyEvent.replaceAll('.', '_')}_A`, created: 5 },
        ),
        5_100,
      );
      await expect(stripe.ingestWebhook(failedWebhook)).resolves.toEqual({
        kind: 'accepted',
        outcome: 'applied',
      });
      await expect(stripe.ingestWebhook(failedWebhook)).resolves.toEqual({
        kind: 'accepted',
        outcome: 'duplicate',
      });
      await expect(
        entitlement.port.authorizeCapability(
          billingContext(),
          'notes-sync',
          5_200,
        ),
      ).resolves.toMatchObject({
        kind: 'denied',
        reason: expectedLockReason,
      });

      await stripe.ingestWebhook(
        webhook(
          stripeEvent(
            'setup_intent.succeeded',
            stripeSetupIntentSucceededObject(),
            { id: 'evt_setup_update_A', created: 6 },
          ),
          6_100,
        ),
      );
      await expect(
        entitlement.port.authorizeCapability(
          billingContext(),
          'notes-read',
          6_200,
        ),
      ).resolves.toMatchObject({
        kind: 'denied',
        reason: expectedLockReason,
      });

      await stripe.ingestWebhook(
        webhook(
          stripeEvent(
            'invoice.paid',
            stripeInvoiceObject({
              id: stripeIds.invoice2,
              paid: true,
              status: 'paid',
            }),
            { id: 'evt_paid_A', created: 7 },
          ),
          7_100,
        ),
      );
      await expect(
        entitlement.port.authorizeCapability(
          billingContext(),
          'notes-read',
          7_200,
        ),
      ).resolves.toMatchObject({ kind: 'allowed', basis: 'paid' });
    },
  );
});

function webhook(event: unknown, receivedAt: number) {
  return {
    rawBody: stripeWebhookBody(event),
    signatureHeader: 'fake-stripe-signature',
    receivedAt,
  } as const;
}
