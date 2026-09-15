import {
  booleanDecoder,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
  type InferDecoder,
} from '../../lib/codec/core';
import {
  billingSubscriptionIdDecoder,
  checkoutIntentIdDecoder,
  parseBillingProvider,
  providerCheckoutReferenceDecoder,
  providerCustomerReferenceDecoder,
  providerEventIdDecoder,
  providerInvoiceReferenceDecoder,
  providerSubscriptionReferenceDecoder,
  reconciliationSnapshotIdDecoder,
  type BillingSubscriptionId,
  type CheckoutIntentId,
  type ProviderCheckoutReference,
  type ProviderCustomerReference,
  type ProviderEventId,
  type ProviderInvoiceReference,
  type ProviderSubscriptionReference,
  type ReconciliationSnapshot,
  type ReconciliationSnapshotId,
  type VerifiedProviderFact,
} from '../billing/public';
import {
  contractEvidenceIdDecoder,
  contractOfferHashDecoder,
  type ContractOfferSnapshot,
} from '../legal-checkout/public';
import {
  STRIPE_API_VERSION,
  type StripeBillingConfiguration,
  type HostedCheckoutCommand,
  type StripeRuntimeMode,
} from './public';

export const STRIPE_WEBHOOK_TOLERANCE_MS = 5 * 60 * 1_000;
export const STRIPE_MAX_WEBHOOK_BYTES = 256 * 1_024;
export const STRIPE_PROVIDER = parseBillingProvider('stripe');
const STRIPE_TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1_000;

export type StripeFormField = readonly [name: string, value: string];

export type StripeCheckoutCreateCommand = {
  readonly apiVersion: typeof STRIPE_API_VERSION;
  readonly idempotencyKey: CheckoutIntentId;
  readonly fields: readonly StripeFormField[];
};

export type StripeSubscriptionSnapshotRequest = {
  readonly apiVersion: typeof STRIPE_API_VERSION;
  readonly providerSubscriptionReference: ProviderSubscriptionReference;
};

export type StripeCheckoutResponse = {
  readonly providerCheckoutReference: ProviderCheckoutReference;
  readonly checkoutUrl: string;
};

export type StripeCheckoutResponseResult =
  | { readonly kind: 'accepted'; readonly response: StripeCheckoutResponse }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'malformed-provider-response'
        | 'provider-mapping-mismatch';
    };

export type StripeSnapshotPlan = {
  readonly snapshotId: ReconciliationSnapshotId;
  readonly subscriptionId: BillingSubscriptionId;
  readonly providerSubscriptionReference: ProviderSubscriptionReference;
  readonly observedAt: number;
  readonly recordedAt: number;
};

export type StripeEventPlan =
  | { readonly kind: 'fact'; readonly fact: VerifiedProviderFact }
  | { readonly kind: 'snapshot'; readonly plan: StripeSnapshotPlan }
  | { readonly kind: 'unsupported' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'malformed-event'
        | 'runtime-mode-mismatch'
        | 'api-version-mismatch';
    };

type StripeEventEnvelope = {
  readonly id: ProviderEventId;
  readonly apiVersion: string;
  readonly createdAt: number;
  readonly livemode: boolean;
  readonly type: string;
  readonly object: unknown;
};

type StripeInvoice = {
  readonly id: ProviderInvoiceReference;
  readonly customer: ProviderCustomerReference;
  readonly providerSubscriptionReference: ProviderSubscriptionReference;
  readonly subscriptionId: BillingSubscriptionId;
  readonly paid: boolean;
  readonly status: 'draft' | 'open' | 'paid' | 'uncollectible' | 'void';
  readonly periodStart: number;
  readonly periodEnd: number;
};

const unknownDecoder: Decoder<unknown> = {
  decode(input) {
    return { ok: true, value: input };
  },
};

const stripeIdentifierDecoder = (prefix: string) =>
  refineDecoder(
    stringDecoder({ minLength: prefix.length + 1, maxLength: 255 }),
    (value) => value.startsWith(prefix) && /^[A-Za-z0-9_]+$/.test(value),
    `expected ${prefix} Stripe identifier`,
  );

const checkoutReferenceDecoder = transformDecoder(
  stripeIdentifierDecoder('cs_'),
  (value) => decodeValue(providerCheckoutReferenceDecoder, value),
);
const eventIdDecoder = transformDecoder(
  stripeIdentifierDecoder('evt_'),
  (value) => decodeValue(providerEventIdDecoder, value),
);
const customerReferenceDecoder = transformDecoder(
  stripeIdentifierDecoder('cus_'),
  (value) => decodeValue(providerCustomerReferenceDecoder, value),
);
const subscriptionReferenceDecoder = transformDecoder(
  stripeIdentifierDecoder('sub_'),
  (value) => decodeValue(providerSubscriptionReferenceDecoder, value),
);
const invoiceReferenceDecoder = transformDecoder(
  stripeIdentifierDecoder('in_'),
  (value) => decodeValue(providerInvoiceReferenceDecoder, value),
);
const setupIntentReferenceDecoder = stripeIdentifierDecoder('seti_');
const paymentIntentReferenceDecoder = stripeIdentifierDecoder('pi_');
const paymentMethodReferenceDecoder = stripeIdentifierDecoder('pm_');
const epochSecondsDecoder = safeIntegerDecoder({
  minimum: 0,
  maximum: Math.floor(Number.MAX_SAFE_INTEGER / 1_000),
});
const stripeObjectStatusDecoder = unionDecoder(
  literalDecoder('draft'),
  literalDecoder('open'),
  literalDecoder('paid'),
  literalDecoder('uncollectible'),
  literalDecoder('void'),
);
const subscriptionStatusDecoder = unionDecoder(
  literalDecoder('incomplete'),
  literalDecoder('incomplete_expired'),
  literalDecoder('trialing'),
  literalDecoder('active'),
  literalDecoder('past_due'),
  literalDecoder('canceled'),
  literalDecoder('unpaid'),
  literalDecoder('paused'),
);
const paymentIntentStatusDecoder = unionDecoder(
  literalDecoder('requires_payment_method'),
  literalDecoder('requires_confirmation'),
  literalDecoder('requires_action'),
  literalDecoder('processing'),
  literalDecoder('requires_capture'),
  literalDecoder('canceled'),
  literalDecoder('succeeded'),
);

const billingMetadataDecoder = objectDecoder(
  { billing_subscription_id: billingSubscriptionIdDecoder },
  { unknownFields: 'allow' },
);
const contractOfferVersionDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 128 }),
  (value) => /^legal-commerce-v1:\d{4}-\d{2}-\d{2}$/.test(value),
  'expected contract offer version',
);
const contractDisclosureVersionDecoder = refineDecoder(
  stringDecoder({ minLength: 10, maxLength: 10 }),
  (value) => /^\d{4}-\d{2}-\d{2}$/.test(value),
  'expected contract disclosure version',
);
const checkoutMetadataDecoder = objectDecoder(
  {
    billing_subscription_id: billingSubscriptionIdDecoder,
    checkout_intent_id: checkoutIntentIdDecoder,
    contract_evidence_id: contractEvidenceIdDecoder,
    contract_offer_hash: contractOfferHashDecoder,
    contract_offer_version: contractOfferVersionDecoder,
    contract_disclosure_version: contractDisclosureVersionDecoder,
  },
  { unknownFields: 'allow' },
);
const eventEnvelopeDecoder = objectDecoder(
  {
    id: eventIdDecoder,
    object: literalDecoder('event'),
    api_version: stringDecoder({ minLength: 1, maxLength: 64 }),
    created: epochSecondsDecoder,
    livemode: booleanDecoder,
    type: stringDecoder({ minLength: 1, maxLength: 128 }),
    data: objectDecoder({ object: unknownDecoder }, { unknownFields: 'allow' }),
  },
  { unknownFields: 'allow' },
);
const invoiceDecoder = objectDecoder(
  {
    id: invoiceReferenceDecoder,
    object: literalDecoder('invoice'),
    customer: customerReferenceDecoder,
    paid: booleanDecoder,
    status: stripeObjectStatusDecoder,
    period_start: epochSecondsDecoder,
    period_end: epochSecondsDecoder,
    parent: objectDecoder(
      {
        type: literalDecoder('subscription_details'),
        subscription_details: objectDecoder(
          {
            subscription: subscriptionReferenceDecoder,
            metadata: billingMetadataDecoder,
          },
          { unknownFields: 'allow' },
        ),
      },
      { unknownFields: 'allow' },
    ),
  },
  { unknownFields: 'allow' },
);
const normalizedInvoiceDecoder = transformDecoder(
  invoiceDecoder,
  normalizeInvoice,
);
const checkoutSessionDecoder = objectDecoder(
  {
    id: checkoutReferenceDecoder,
    object: literalDecoder('checkout.session'),
    mode: literalDecoder('subscription'),
    status: literalDecoder('complete'),
    livemode: booleanDecoder,
    customer: customerReferenceDecoder,
    subscription: subscriptionReferenceDecoder,
    client_reference_id: checkoutIntentIdDecoder,
    metadata: checkoutMetadataDecoder,
    url: nullableDecoder(stringDecoder({ minLength: 1, maxLength: 2_048 })),
  },
  { unknownFields: 'allow' },
);
const setupIntentEventDecoder = objectDecoder(
  {
    id: setupIntentReferenceDecoder,
    object: literalDecoder('setup_intent'),
    status: literalDecoder('succeeded'),
    usage: literalDecoder('off_session'),
    customer: customerReferenceDecoder,
    payment_method: paymentMethodReferenceDecoder,
    metadata: objectDecoder(
      {
        billing_subscription_id: billingSubscriptionIdDecoder,
        provider_subscription_id: subscriptionReferenceDecoder,
      },
      { unknownFields: 'allow' },
    ),
  },
  { unknownFields: 'allow' },
);
const subscriptionEventDecoder = objectDecoder(
  {
    id: subscriptionReferenceDecoder,
    object: literalDecoder('subscription'),
    customer: customerReferenceDecoder,
    status: subscriptionStatusDecoder,
    metadata: billingMetadataDecoder,
    cancel_at: nullableDecoder(epochSecondsDecoder),
    ended_at: nullableDecoder(epochSecondsDecoder),
  },
  { unknownFields: 'allow' },
);
const checkoutCreateResponseDecoder = objectDecoder(
  {
    id: checkoutReferenceDecoder,
    object: literalDecoder('checkout.session'),
    mode: literalDecoder('subscription'),
    livemode: booleanDecoder,
    client_reference_id: checkoutIntentIdDecoder,
    metadata: checkoutMetadataDecoder,
    url: stringDecoder({ minLength: 1, maxLength: 2_048 }),
  },
  { unknownFields: 'allow' },
);

const subscriptionSnapshotDecoder = objectDecoder(
  {
    subscription: objectDecoder(
      {
        id: subscriptionReferenceDecoder,
        object: literalDecoder('subscription'),
        customer: customerReferenceDecoder,
        status: subscriptionStatusDecoder,
        created: epochSecondsDecoder,
        metadata: billingMetadataDecoder,
        trial_start: nullableDecoder(epochSecondsDecoder),
        trial_end: nullableDecoder(epochSecondsDecoder),
        default_payment_method: nullableDecoder(paymentMethodReferenceDecoder),
        cancel_at: nullableDecoder(epochSecondsDecoder),
        canceled_at: nullableDecoder(epochSecondsDecoder),
        ended_at: nullableDecoder(epochSecondsDecoder),
      },
      { unknownFields: 'allow' },
    ),
    setup_intent: nullableDecoder(
      objectDecoder(
        {
          id: setupIntentReferenceDecoder,
          object: literalDecoder('setup_intent'),
          status: unionDecoder(
            literalDecoder('requires_payment_method'),
            literalDecoder('requires_confirmation'),
            literalDecoder('requires_action'),
            literalDecoder('processing'),
            literalDecoder('canceled'),
            literalDecoder('succeeded'),
          ),
          usage: literalDecoder('off_session'),
          customer: customerReferenceDecoder,
          payment_method: nullableDecoder(paymentMethodReferenceDecoder),
          created: epochSecondsDecoder,
        },
        { unknownFields: 'allow' },
      ),
    ),
    latest_invoice: nullableDecoder(normalizedInvoiceDecoder),
    latest_payment_intent: nullableDecoder(
      objectDecoder(
        {
          id: paymentIntentReferenceDecoder,
          object: literalDecoder('payment_intent'),
          status: paymentIntentStatusDecoder,
          customer: customerReferenceDecoder,
          invoice: invoiceReferenceDecoder,
          created: epochSecondsDecoder,
        },
        { unknownFields: 'allow' },
      ),
    ),
  },
  { unknownFields: 'reject' },
);

export function planStripeCheckout(
  configuration: StripeBillingConfiguration,
  command: HostedCheckoutCommand,
): StripeCheckoutCreateCommand {
  const contract = command.contract;
  return {
    apiVersion: configuration.apiVersion,
    idempotencyKey: command.checkoutIntentId,
    fields: [
      ['mode', 'subscription'],
      ['submit_type', 'subscribe'],
      ['line_items[0][price]', configuration.priceReference],
      ['line_items[0][quantity]', '1'],
      ['payment_method_collection', 'always'],
      ['payment_method_options[card][request_three_d_secure]', 'any'],
      ['subscription_data[trial_period_days]', '14'],
      [
        'subscription_data[trial_settings][end_behavior][missing_payment_method]',
        'cancel',
      ],
      ['client_reference_id', command.checkoutIntentId],
      ['metadata[billing_subscription_id]', command.subscriptionId],
      ['metadata[checkout_intent_id]', command.checkoutIntentId],
      ['metadata[contract_evidence_id]', contract.evidenceId],
      ['metadata[contract_offer_hash]', contract.offerHash],
      ['metadata[contract_offer_version]', contract.offer.offerVersion],
      [
        'metadata[contract_disclosure_version]',
        contract.offer.disclosureVersion,
      ],
      [
        'subscription_data[metadata][billing_subscription_id]',
        command.subscriptionId,
      ],
      [
        'subscription_data[metadata][contract_evidence_id]',
        contract.evidenceId,
      ],
      ['subscription_data[metadata][contract_offer_hash]', contract.offerHash],
      [
        'custom_text[submit][message]',
        stripeContractSubmitMessage(contract.offer),
      ],
      ['success_url', configuration.successUrl],
      ['cancel_url', configuration.cancelUrl],
    ],
  };
}

export function decodeStripeCheckoutResponse(
  input: unknown,
  expected: Pick<
    HostedCheckoutCommand,
    'subscriptionId' | 'checkoutIntentId' | 'contract'
  > & {
    readonly mode: StripeRuntimeMode;
  },
): StripeCheckoutResponseResult {
  const decoded = checkoutCreateResponseDecoder.decode(input);
  if (!decoded.ok) {
    return { kind: 'rejected', reason: 'malformed-provider-response' };
  }
  const response = decoded.value;
  if (
    response.livemode !== (expected.mode === 'live') ||
    response.client_reference_id !== expected.checkoutIntentId ||
    response.metadata.billing_subscription_id !== expected.subscriptionId ||
    response.metadata.checkout_intent_id !== expected.checkoutIntentId ||
    response.metadata.contract_evidence_id !== expected.contract.evidenceId ||
    response.metadata.contract_offer_hash !== expected.contract.offerHash ||
    response.metadata.contract_offer_version !==
      expected.contract.offer.offerVersion ||
    response.metadata.contract_disclosure_version !==
      expected.contract.offer.disclosureVersion
  ) {
    return { kind: 'rejected', reason: 'provider-mapping-mismatch' };
  }
  if (!isStripeCheckoutUrl(response.url)) {
    return { kind: 'rejected', reason: 'malformed-provider-response' };
  }
  return {
    kind: 'accepted',
    response: {
      providerCheckoutReference: response.id,
      checkoutUrl: response.url,
    },
  };
}

export function stripeContractSubmitMessage(
  offer: ContractOfferSnapshot,
): string {
  const cadence = offer.billingPeriod === 'monthly' ? '毎月' : '毎年';
  return `14日間は0円です。15日目から税込${offer.renewalChargeYen}円を${cadence}自動課金します。支払い方法の登録が必要です。支払い失敗または追加認証が必要な場合はオンライン利用を停止し、invoice.paid確認後に再開します。解約と退会は別手続です。`;
}

export function decodeStripeEventPlan(
  input: unknown,
  expected: {
    readonly mode: StripeRuntimeMode;
    readonly apiVersion: typeof STRIPE_API_VERSION;
    readonly receivedAt: number;
  },
): StripeEventPlan {
  if (!validMilliseconds(expected.receivedAt)) {
    return { kind: 'rejected', reason: 'malformed-event' };
  }
  const decoded = eventEnvelopeDecoder.decode(input);
  if (!decoded.ok) return { kind: 'rejected', reason: 'malformed-event' };
  const event: StripeEventEnvelope = {
    id: decoded.value.id,
    apiVersion: decoded.value.api_version,
    createdAt: toMilliseconds(decoded.value.created),
    livemode: decoded.value.livemode,
    type: decoded.value.type,
    object: decoded.value.data.object,
  };
  if (event.livemode !== (expected.mode === 'live')) {
    return { kind: 'rejected', reason: 'runtime-mode-mismatch' };
  }
  if (event.apiVersion !== expected.apiVersion) {
    return { kind: 'rejected', reason: 'api-version-mismatch' };
  }
  if (event.createdAt > expected.receivedAt) {
    return { kind: 'rejected', reason: 'malformed-event' };
  }

  switch (event.type) {
    case 'checkout.session.completed':
      return checkoutCompletedPlan(event, expected.receivedAt);
    case 'invoice.paid':
    case 'invoice.payment_failed':
    case 'invoice.payment_action_required':
      return invoiceEventPlan(event, expected.receivedAt);
    case 'setup_intent.succeeded':
      return setupIntentSucceededPlan(event, expected.receivedAt);
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return subscriptionEventPlan(event, expected.receivedAt);
    default:
      return { kind: 'unsupported' };
  }
}

export function decodeStripeReconciliationSnapshot(
  input: unknown,
  plan: StripeSnapshotPlan,
): ReconciliationSnapshot | undefined {
  if (
    !validMilliseconds(plan.observedAt) ||
    !validMilliseconds(plan.recordedAt) ||
    plan.recordedAt < plan.observedAt
  ) {
    return undefined;
  }
  const decoded = subscriptionSnapshotDecoder.decode(input);
  if (!decoded.ok) return undefined;
  const snapshot = decoded.value;
  const subscription = snapshot.subscription;
  if (
    subscription.id !== plan.providerSubscriptionReference ||
    subscription.metadata.billing_subscription_id !== plan.subscriptionId
  ) {
    return undefined;
  }

  const setup = snapshot.setup_intent;
  const paymentMethodReady =
    setup !== null &&
    setup.status === 'succeeded' &&
    setup.customer === subscription.customer &&
    setup.payment_method !== null &&
    setup.payment_method === subscription.default_payment_method;
  const trial = buildTrial(subscription, paymentMethodReady);
  if (trial === undefined) return undefined;

  const invoice = snapshot.latest_invoice;
  if (invoice !== null && !invoiceMatches(invoice, subscription, plan)) {
    return undefined;
  }
  const paymentIntent = snapshot.latest_payment_intent;
  if (
    paymentIntent !== null &&
    (invoice === null ||
      paymentIntent.invoice !== invoice.id ||
      paymentIntent.customer !== subscription.customer)
  ) {
    return undefined;
  }

  const latestPaidInvoice =
    invoice !== null && invoice.paid && invoice.status === 'paid'
      ? {
          invoiceReference: invoice.id,
          paidAt: plan.observedAt,
          periodStartedAt: invoice.periodStart,
          periodEndsAt: invoice.periodEnd,
        }
      : null;
  const delinquency = delinquencyFromSnapshot(
    invoice,
    paymentIntent,
    plan.observedAt,
  );
  const cancelledAt =
    subscription.status === 'canceled'
      ? toMilliseconds(
          subscription.ended_at ??
            subscription.canceled_at ??
            Math.floor(plan.observedAt / 1_000),
        )
      : null;

  return {
    snapshotId: plan.snapshotId,
    subscriptionId: plan.subscriptionId,
    provider: STRIPE_PROVIDER,
    providerCustomerReference: subscription.customer,
    providerSubscriptionReference: subscription.id,
    observedAt: plan.observedAt,
    recordedAt: plan.recordedAt,
    paymentMethodReady,
    paymentMethodUpdatedAt:
      setup === null
        ? toMilliseconds(subscription.created)
        : toMilliseconds(setup.created),
    trial,
    latestPaidInvoice,
    delinquency,
    cancelAt:
      subscription.cancel_at === null
        ? null
        : toMilliseconds(subscription.cancel_at),
    cancellationUpdatedAt: plan.observedAt,
    cancelledAt,
  };
}

function checkoutCompletedPlan(
  event: StripeEventEnvelope,
  receivedAt: number,
): StripeEventPlan {
  const decoded = checkoutSessionDecoder.decode(event.object);
  if (!decoded.ok) return { kind: 'rejected', reason: 'malformed-event' };
  const session = decoded.value;
  if (
    session.livemode !== event.livemode ||
    session.client_reference_id !== session.metadata.checkout_intent_id
  ) {
    return { kind: 'rejected', reason: 'malformed-event' };
  }
  const snapshotId = reconciliationSnapshotIdDecoder.decode(
    `${event.id}:checkout`,
  );
  if (!snapshotId.ok) return { kind: 'rejected', reason: 'malformed-event' };
  return {
    kind: 'snapshot',
    plan: {
      snapshotId: snapshotId.value,
      subscriptionId: session.metadata.billing_subscription_id,
      providerSubscriptionReference: session.subscription,
      observedAt: event.createdAt,
      recordedAt: receivedAt,
    },
  };
}

function invoiceEventPlan(
  event: StripeEventEnvelope,
  receivedAt: number,
): StripeEventPlan {
  const invoice = decodeInvoice(event.object);
  if (invoice === undefined || invoice.periodEnd <= invoice.periodStart) {
    return { kind: 'rejected', reason: 'malformed-event' };
  }
  const base = {
    subscriptionId: invoice.subscriptionId,
    provider: STRIPE_PROVIDER,
    eventId: event.id,
    providerCustomerReference: invoice.customer,
    providerSubscriptionReference: invoice.providerSubscriptionReference,
    occurredAt: event.createdAt,
    recordedAt: receivedAt,
  } as const;
  switch (event.type) {
    case 'invoice.paid':
      return invoice.paid && invoice.status === 'paid'
        ? {
            kind: 'fact',
            fact: {
              ...base,
              kind: 'invoice-paid',
              invoiceReference: invoice.id,
              paidPeriodStartedAt: invoice.periodStart,
              paidPeriodEndsAt: invoice.periodEnd,
            },
          }
        : { kind: 'rejected', reason: 'malformed-event' };
    case 'invoice.payment_failed':
      return !invoice.paid && invoice.status === 'open'
        ? {
            kind: 'fact',
            fact: {
              ...base,
              kind: 'invoice-payment-failed',
              invoiceReference: invoice.id,
            },
          }
        : { kind: 'rejected', reason: 'malformed-event' };
    case 'invoice.payment_action_required':
      return !invoice.paid && invoice.status === 'open'
        ? {
            kind: 'fact',
            fact: {
              ...base,
              kind: 'invoice-payment-action-required',
              invoiceReference: invoice.id,
            },
          }
        : { kind: 'rejected', reason: 'malformed-event' };
    default:
      return { kind: 'unsupported' };
  }
}

function setupIntentSucceededPlan(
  event: StripeEventEnvelope,
  receivedAt: number,
): StripeEventPlan {
  const decoded = setupIntentEventDecoder.decode(event.object);
  if (!decoded.ok) return { kind: 'rejected', reason: 'malformed-event' };
  return {
    kind: 'fact',
    fact: {
      kind: 'payment-method-updated',
      subscriptionId: decoded.value.metadata.billing_subscription_id,
      provider: STRIPE_PROVIDER,
      eventId: event.id,
      providerCustomerReference: decoded.value.customer,
      providerSubscriptionReference:
        decoded.value.metadata.provider_subscription_id,
      occurredAt: event.createdAt,
      recordedAt: receivedAt,
    },
  };
}

function subscriptionEventPlan(
  event: StripeEventEnvelope,
  receivedAt: number,
): StripeEventPlan {
  const decoded = subscriptionEventDecoder.decode(event.object);
  if (!decoded.ok) return { kind: 'rejected', reason: 'malformed-event' };
  const subscription = decoded.value;
  const base = {
    subscriptionId: subscription.metadata.billing_subscription_id,
    provider: STRIPE_PROVIDER,
    eventId: event.id,
    providerCustomerReference: subscription.customer,
    providerSubscriptionReference: subscription.id,
    occurredAt: event.createdAt,
    recordedAt: receivedAt,
  } as const;
  if (event.type === 'customer.subscription.deleted') {
    const endedAt = toMilliseconds(
      subscription.ended_at ?? Math.floor(event.createdAt / 1_000),
    );
    return {
      kind: 'fact',
      fact: {
        ...base,
        kind: 'subscription-cancelled',
        cancelledAt: Math.max(event.createdAt, endedAt),
      },
    };
  }
  return subscription.cancel_at === null
    ? { kind: 'unsupported' }
    : {
        kind: 'fact',
        fact: {
          ...base,
          kind: 'cancellation-scheduled',
          cancelAt: Math.max(
            event.createdAt,
            toMilliseconds(subscription.cancel_at),
          ),
        },
      };
}

function decodeInvoice(input: unknown): StripeInvoice | undefined {
  const decoded = normalizedInvoiceDecoder.decode(input);
  if (!decoded.ok) return undefined;
  return decoded.value;
}

function normalizeInvoice(
  invoice: InferDecoder<typeof invoiceDecoder>,
): StripeInvoice {
  const details = invoice.parent.subscription_details;
  return {
    id: invoice.id,
    customer: invoice.customer,
    providerSubscriptionReference: details.subscription,
    subscriptionId: details.metadata.billing_subscription_id,
    paid: invoice.paid,
    status: invoice.status,
    periodStart: toMilliseconds(invoice.period_start),
    periodEnd: toMilliseconds(invoice.period_end),
  };
}

function buildTrial(
  subscription: {
    readonly status: string;
    readonly created: number;
    readonly trial_start: number | null;
    readonly trial_end: number | null;
  },
  paymentMethodReady: boolean,
): ReconciliationSnapshot['trial'] | undefined {
  if (subscription.status !== 'trialing') return null;
  if (
    !paymentMethodReady ||
    subscription.trial_start === null ||
    subscription.trial_end === null
  ) {
    return undefined;
  }
  const startedAt = toMilliseconds(subscription.trial_start);
  const endsAt = toMilliseconds(subscription.trial_end);
  if (endsAt - startedAt !== STRIPE_TRIAL_DURATION_MS) return undefined;
  return {
    startedAt,
    endsAt,
    observedAt: toMilliseconds(subscription.created),
  };
}

function invoiceMatches(
  invoice: StripeInvoice,
  subscription: {
    readonly id: ProviderSubscriptionReference;
    readonly customer: StripeInvoice['customer'];
  },
  plan: StripeSnapshotPlan,
): boolean {
  return (
    invoice.providerSubscriptionReference === subscription.id &&
    invoice.customer === subscription.customer &&
    invoice.subscriptionId === plan.subscriptionId &&
    invoice.periodEnd > invoice.periodStart
  );
}

function delinquencyFromSnapshot(
  invoice: StripeInvoice | null,
  paymentIntent: {
    readonly status:
      | 'requires_payment_method'
      | 'requires_confirmation'
      | 'requires_action'
      | 'processing'
      | 'requires_capture'
      | 'canceled'
      | 'succeeded';
  } | null,
  observedAt: number,
): ReconciliationSnapshot['delinquency'] {
  if (
    invoice === null ||
    paymentIntent === null ||
    invoice.paid ||
    invoice.status !== 'open'
  ) {
    return null;
  }
  if (paymentIntent.status === 'requires_action') {
    return {
      reason: 'payment-action-required',
      invoiceReference: invoice.id,
      occurredAt: observedAt,
    };
  }
  return paymentIntent.status === 'requires_payment_method'
    ? {
        reason: 'payment-failed',
        invoiceReference: invoice.id,
        occurredAt: observedAt,
      }
    : null;
}

function isStripeCheckoutUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'checkout.stripe.com' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function toMilliseconds(seconds: number): number {
  return seconds * 1_000;
}

function validMilliseconds(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function decodeValue<TValue>(decoder: Decoder<TValue>, input: unknown): TValue {
  const result = decoder.decode(input);
  if (!result.ok) {
    throw new Error('composed Stripe identifier decoder rejected input');
  }
  return result.value;
}
