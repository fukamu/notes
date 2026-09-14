import {
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import type { VaultContext } from '../../lib/domain/identity';
import type {
  BillingSubscriptionId,
  CheckoutIntentId,
  ProviderCheckoutReference,
  ProviderFactResult,
  ProviderSubscriptionReference,
  ReconciliationSnapshotId,
} from '../billing/public';
import type {
  ContractEvidenceId,
  ContractOfferHash,
  ContractOfferSnapshot,
} from '../legal-checkout/public';

declare const stripePriceReferenceBrand: unique symbol;
declare const stripeReturnUrlBrand: unique symbol;
declare const stripeWebhookSecretBrand: unique symbol;

export const STRIPE_API_VERSION = '2026-02-25.clover' as const;

export type StripeRuntimeMode = 'test' | 'live';
export type StripePriceReference = string & {
  readonly [stripePriceReferenceBrand]: 'StripePriceReference';
};
export type StripeReturnUrl = string & {
  readonly [stripeReturnUrlBrand]: 'StripeReturnUrl';
};
export type StripeWebhookSecret = string & {
  readonly [stripeWebhookSecretBrand]: 'StripeWebhookSecret';
};

export type StripeBillingConfiguration = {
  readonly mode: StripeRuntimeMode;
  readonly apiVersion: typeof STRIPE_API_VERSION;
  readonly priceReference: StripePriceReference;
  readonly successUrl: StripeReturnUrl;
  readonly cancelUrl: StripeReturnUrl;
};

const stripeModeDecoder = unionDecoder(
  literalDecoder('test'),
  literalDecoder('live'),
);
const stripePriceReferenceDecoder: Decoder<StripePriceReference> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 7, maxLength: 255 }),
      (value) => /^price_[A-Za-z0-9]+$/.test(value),
      'expected a Stripe Price reference',
    ),
    (value) => value as StripePriceReference,
  );
const stripeReturnUrlDecoder: Decoder<StripeReturnUrl> = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 1, maxLength: 2_048 }),
    isAllowedReturnUrl,
    'expected HTTPS or a loopback HTTP URL without credentials or fragment',
  ),
  (value) => value as StripeReturnUrl,
);
const stripeWebhookSecretDecoder: Decoder<StripeWebhookSecret> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 22, maxLength: 255 }),
      (value) => /^whsec_[A-Za-z0-9]+$/.test(value),
      'expected a Stripe endpoint signing secret',
    ),
    (value) => value as StripeWebhookSecret,
  );

export const stripeBillingConfigurationDecoder: Decoder<StripeBillingConfiguration> =
  objectDecoder({
    mode: stripeModeDecoder,
    apiVersion: literalDecoder(STRIPE_API_VERSION),
    priceReference: stripePriceReferenceDecoder,
    successUrl: stripeReturnUrlDecoder,
    cancelUrl: stripeReturnUrlDecoder,
  });

export function parseStripeBillingConfiguration(
  input: unknown,
): StripeBillingConfiguration {
  return decodeOrThrow(
    stripeBillingConfigurationDecoder,
    input,
    'Stripe Billing configuration',
  );
}

export function parseStripeWebhookSecret(input: unknown): StripeWebhookSecret {
  return decodeOrThrow(
    stripeWebhookSecretDecoder,
    input,
    'Stripe webhook secret',
  );
}

export type HostedCheckoutCommand = {
  readonly subscriptionId: BillingSubscriptionId;
  readonly checkoutIntentId: CheckoutIntentId;
  readonly createdAt: number;
  readonly contract: HostedCheckoutContract;
};

export type HostedCheckoutContract = {
  readonly evidenceId: ContractEvidenceId;
  readonly offerHash: ContractOfferHash;
  readonly offer: ContractOfferSnapshot;
};

export type HostedCheckoutResult =
  | {
      readonly kind: 'redirect';
      readonly checkoutUrl: string;
      readonly providerCheckoutReference: ProviderCheckoutReference;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-input'
        | 'billing-rejected'
        | 'provider-unavailable'
        | 'malformed-provider-response'
        | 'provider-mapping-mismatch';
    };

export type StripeWebhookRequest = {
  readonly rawBody: Uint8Array;
  readonly signatureHeader: unknown;
  readonly receivedAt: number;
};

export type StripeWebhookResult =
  | {
      readonly kind: 'accepted';
      readonly outcome: Exclude<
        ProviderFactResult,
        { readonly kind: 'rejected' }
      >['kind'];
    }
  | { readonly kind: 'ignored'; readonly reason: 'unsupported-event' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-signature'
        | 'malformed-event'
        | 'runtime-mode-mismatch'
        | 'api-version-mismatch'
        | 'provider-unavailable'
        | 'billing-rejected';
    };

export type StripeReconciliationCommand = {
  readonly snapshotId: ReconciliationSnapshotId;
  readonly subscriptionId: BillingSubscriptionId;
  readonly providerSubscriptionReference: ProviderSubscriptionReference;
  readonly observedAt: number;
  readonly recordedAt: number;
};

export type StripeBillingAdapter = {
  beginHostedCheckout(
    context: VaultContext,
    command: HostedCheckoutCommand,
  ): Promise<HostedCheckoutResult>;
  ingestWebhook(request: StripeWebhookRequest): Promise<StripeWebhookResult>;
  reconcileSubscription(
    command: StripeReconciliationCommand,
  ): Promise<StripeWebhookResult>;
};

function isAllowedReturnUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.username !== '' || url.password !== '' || url.hash !== '') {
      return false;
    }
    if (url.protocol === 'https:') return true;
    return (
      url.protocol === 'http:' &&
      (url.hostname === 'localhost' ||
        url.hostname === '127.0.0.1' ||
        url.hostname === '[::1]')
    );
  } catch {
    return false;
  }
}
