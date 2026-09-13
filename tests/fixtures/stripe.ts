import {
  parseProviderCustomerReference,
  parseProviderInvoiceReference,
  parseProviderSubscriptionReference,
  parseReconciliationSnapshotId,
  type BeginCheckoutCommand,
} from '@/server/billing/public';
import { STRIPE_PROVIDER } from '@/server/stripe/core';
import {
  STRIPE_API_VERSION,
  parseStripeBillingConfiguration,
} from '@/server/stripe/public';
import { billingIds } from './billing';

export const stripeConfiguration = parseStripeBillingConfiguration({
  mode: 'test',
  apiVersion: STRIPE_API_VERSION,
  priceReference: 'price_FukamuMonthly',
  successUrl:
    'https://notes.example.test/billing/success?session_id={CHECKOUT_SESSION_ID}',
  cancelUrl: 'https://notes.example.test/billing/cancel',
});

export const stripeIds = {
  checkout: 'cs_test_FukamuA',
  customer: parseProviderCustomerReference('cus_FukamuA'),
  subscription: parseProviderSubscriptionReference('sub_FukamuA'),
  invoice1: parseProviderInvoiceReference('in_Fukamu1'),
  invoice2: parseProviderInvoiceReference('in_Fukamu2'),
  snapshot: parseReconciliationSnapshotId('stripe_snapshot_A'),
} as const;

export function stripeBeginCheckoutCommand(): BeginCheckoutCommand {
  return {
    subscriptionId: billingIds.subscriptionA,
    checkoutIntentId: billingIds.checkoutA,
    provider: STRIPE_PROVIDER,
    createdAt: 1_000,
  };
}

export function stripeCheckoutResponse(
  overrides: Readonly<Record<string, unknown>> = {},
): unknown {
  return {
    id: stripeIds.checkout,
    object: 'checkout.session',
    mode: 'subscription',
    livemode: false,
    client_reference_id: billingIds.checkoutA,
    metadata: {
      billing_subscription_id: billingIds.subscriptionA,
      checkout_intent_id: billingIds.checkoutA,
    },
    url: 'https://checkout.stripe.com/c/pay/cs_test_FukamuA',
    ...overrides,
  };
}

export function stripeEvent(
  type: string,
  object: unknown,
  input: {
    readonly id?: string;
    readonly created?: number;
    readonly apiVersion?: string;
    readonly livemode?: boolean;
  } = {},
): unknown {
  return {
    id: input.id ?? `evt_${type.replaceAll('.', '_')}`,
    object: 'event',
    api_version: input.apiVersion ?? STRIPE_API_VERSION,
    created: input.created ?? 2,
    livemode: input.livemode ?? false,
    pending_webhooks: 1,
    request: { id: null, idempotency_key: null },
    type,
    data: { object },
  };
}

export function stripeCheckoutCompletedObject(): unknown {
  return {
    id: stripeIds.checkout,
    object: 'checkout.session',
    mode: 'subscription',
    status: 'complete',
    livemode: false,
    customer: stripeIds.customer,
    subscription: stripeIds.subscription,
    client_reference_id: billingIds.checkoutA,
    metadata: {
      billing_subscription_id: billingIds.subscriptionA,
      checkout_intent_id: billingIds.checkoutA,
    },
    url: null,
  };
}

export function stripeInvoiceObject(input: {
  readonly id?: string;
  readonly paid: boolean;
  readonly status: 'open' | 'paid';
  readonly periodStart?: number;
  readonly periodEnd?: number;
  readonly subscriptionId?: string;
}): unknown {
  return {
    id: input.id ?? stripeIds.invoice1,
    object: 'invoice',
    customer: stripeIds.customer,
    paid: input.paid,
    status: input.status,
    period_start: input.periodStart ?? 10,
    period_end: input.periodEnd ?? 2_592_010,
    parent: {
      type: 'subscription_details',
      subscription_details: {
        subscription: stripeIds.subscription,
        metadata: {
          billing_subscription_id:
            input.subscriptionId ?? billingIds.subscriptionA,
        },
      },
    },
  };
}

export function stripeSetupIntentSucceededObject(): unknown {
  return {
    id: 'seti_FukamuA',
    object: 'setup_intent',
    status: 'succeeded',
    usage: 'off_session',
    customer: stripeIds.customer,
    payment_method: 'pm_FukamuA',
    metadata: {
      billing_subscription_id: billingIds.subscriptionA,
      provider_subscription_id: stripeIds.subscription,
    },
  };
}

export function stripeSubscriptionObject(
  input: {
    readonly status?: string;
    readonly cancelAt?: number | null;
    readonly endedAt?: number | null;
  } = {},
): unknown {
  return {
    id: stripeIds.subscription,
    object: 'subscription',
    customer: stripeIds.customer,
    status: input.status ?? 'trialing',
    metadata: { billing_subscription_id: billingIds.subscriptionA },
    cancel_at: input.cancelAt ?? null,
    ended_at: input.endedAt ?? null,
  };
}

export function stripeSubscriptionSnapshot(
  input: {
    readonly status?: string;
    readonly setupStatus?: string;
    readonly invoicePaid?: boolean;
    readonly invoiceStatus?: 'open' | 'paid';
    readonly paymentIntentStatus?: string | null;
    readonly billingSubscriptionId?: string;
    readonly providerSubscriptionId?: string;
  } = {},
): unknown {
  const invoicePaid = input.invoicePaid ?? false;
  const invoiceStatus = input.invoiceStatus ?? 'open';
  const paymentIntentStatus = input.paymentIntentStatus ?? null;
  const invoice = stripeInvoiceObject({
    paid: invoicePaid,
    status: invoiceStatus,
    subscriptionId: input.billingSubscriptionId ?? billingIds.subscriptionA,
  });
  return {
    subscription: {
      id: input.providerSubscriptionId ?? stripeIds.subscription,
      object: 'subscription',
      customer: stripeIds.customer,
      status: input.status ?? 'trialing',
      created: 2,
      metadata: {
        billing_subscription_id:
          input.billingSubscriptionId ?? billingIds.subscriptionA,
      },
      trial_start: 2,
      trial_end: 1_209_602,
      default_payment_method: 'pm_FukamuA',
      cancel_at: null,
      canceled_at: null,
      ended_at: null,
    },
    setup_intent: {
      id: 'seti_FukamuA',
      object: 'setup_intent',
      status: input.setupStatus ?? 'succeeded',
      usage: 'off_session',
      customer: stripeIds.customer,
      payment_method: 'pm_FukamuA',
      created: 2,
    },
    latest_invoice: invoice,
    latest_payment_intent:
      paymentIntentStatus === null
        ? null
        : {
            id: 'pi_FukamuA',
            object: 'payment_intent',
            status: paymentIntentStatus,
            customer: stripeIds.customer,
            invoice: stripeIds.invoice1,
            created: 2,
          },
  };
}

export function stripeWebhookBody(event: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(event));
}
