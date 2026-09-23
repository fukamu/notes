import {
  decodeOrThrow,
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import {
  accountIdDecoder,
  vaultIdDecoder,
  type AccountId,
  type VaultContext,
  type VaultId,
} from '../../lib/domain/identity';
import { validate as validateUuid, version as uuidVersion } from 'uuid';

declare const billingIdentifierBrand: unique symbol;
declare const billingProviderBrand: unique symbol;
declare const providerReferenceBrand: unique symbol;
declare const billingVersionBrand: unique symbol;
declare const subscriptionCancellationIdempotencyKeyBrand: unique symbol;

type BillingIdentifier<TName extends string> = string & {
  readonly [billingIdentifierBrand]: TName;
};

type ProviderReference<TName extends string> = string & {
  readonly [providerReferenceBrand]: TName;
};

export type BillingSubscriptionId = BillingIdentifier<'BillingSubscriptionId'>;
export type CheckoutIntentId = BillingIdentifier<'CheckoutIntentId'>;
export type BillingProvider = string & {
  readonly [billingProviderBrand]: 'BillingProvider';
};
export type ProviderEventId = ProviderReference<'ProviderEventId'>;
export type ProviderCustomerReference =
  ProviderReference<'ProviderCustomerReference'>;
export type ProviderSubscriptionReference =
  ProviderReference<'ProviderSubscriptionReference'>;
export type ProviderCheckoutReference =
  ProviderReference<'ProviderCheckoutReference'>;
export type ProviderInvoiceReference =
  ProviderReference<'ProviderInvoiceReference'>;
export type ReconciliationSnapshotId =
  ProviderReference<'ReconciliationSnapshotId'>;
export type BillingVersion = number & {
  readonly [billingVersionBrand]: 'BillingVersion';
};
export type SubscriptionCancellationIdempotencyKey = string & {
  readonly [subscriptionCancellationIdempotencyKeyBrand]: 'SubscriptionCancellationIdempotencyKey';
};
export type BillingOwnerScope = Pick<VaultContext, 'accountId' | 'vaultId'>;

const uuidV7Decoder = refineDecoder(
  stringDecoder({ minLength: 36, maxLength: 36 }),
  (value) => validateUuid(value) && uuidVersion(value) === 7,
  'expected UUIDv7',
);

function brandedUuidDecoder<TValue extends string>(): Decoder<TValue> {
  return transformDecoder(uuidV7Decoder, (value) => value as TValue);
}

function providerReferenceDecoder<TValue extends string>(): Decoder<TValue> {
  return transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 255 }),
      (value) => /^[\x21-\x7e]+$/.test(value),
      'expected a printable provider reference without whitespace',
    ),
    (value) => value as TValue,
  );
}

export const billingSubscriptionIdDecoder =
  brandedUuidDecoder<BillingSubscriptionId>();
export const checkoutIntentIdDecoder = brandedUuidDecoder<CheckoutIntentId>();
export const billingProviderDecoder: Decoder<BillingProvider> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 32 }),
      (value) => /^[a-z][a-z0-9-]*$/.test(value),
      'expected a lowercase provider identifier',
    ),
    (value) => value as BillingProvider,
  );
export const providerEventIdDecoder =
  providerReferenceDecoder<ProviderEventId>();
export const providerCustomerReferenceDecoder =
  providerReferenceDecoder<ProviderCustomerReference>();
export const providerSubscriptionReferenceDecoder =
  providerReferenceDecoder<ProviderSubscriptionReference>();
export const providerCheckoutReferenceDecoder =
  providerReferenceDecoder<ProviderCheckoutReference>();
export const providerInvoiceReferenceDecoder =
  providerReferenceDecoder<ProviderInvoiceReference>();
export const reconciliationSnapshotIdDecoder =
  providerReferenceDecoder<ReconciliationSnapshotId>();
export const billingVersionDecoder: Decoder<BillingVersion> = transformDecoder(
  safeIntegerDecoder({ minimum: 1, maximum: 2_147_483_647 }),
  (value) => value as BillingVersion,
);
export const subscriptionCancellationIdempotencyKeyDecoder: Decoder<SubscriptionCancellationIdempotencyKey> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 255 }),
      (value) => /^[A-Za-z0-9][A-Za-z0-9:_-]*$/.test(value),
      'expected a non-sensitive provider idempotency key',
    ),
    (value) => value as SubscriptionCancellationIdempotencyKey,
  );

export function parseBillingSubscriptionId(
  input: unknown,
): BillingSubscriptionId {
  return decodeOrThrow(
    billingSubscriptionIdDecoder,
    input,
    'BillingSubscriptionId',
  );
}

export function parseCheckoutIntentId(input: unknown): CheckoutIntentId {
  return decodeOrThrow(checkoutIntentIdDecoder, input, 'CheckoutIntentId');
}

export function parseBillingProvider(input: unknown): BillingProvider {
  return decodeOrThrow(billingProviderDecoder, input, 'BillingProvider');
}

export function parseProviderEventId(input: unknown): ProviderEventId {
  return decodeOrThrow(providerEventIdDecoder, input, 'ProviderEventId');
}

export function parseProviderCustomerReference(
  input: unknown,
): ProviderCustomerReference {
  return decodeOrThrow(
    providerCustomerReferenceDecoder,
    input,
    'ProviderCustomerReference',
  );
}

export function parseProviderSubscriptionReference(
  input: unknown,
): ProviderSubscriptionReference {
  return decodeOrThrow(
    providerSubscriptionReferenceDecoder,
    input,
    'ProviderSubscriptionReference',
  );
}

export function parseProviderCheckoutReference(
  input: unknown,
): ProviderCheckoutReference {
  return decodeOrThrow(
    providerCheckoutReferenceDecoder,
    input,
    'ProviderCheckoutReference',
  );
}

export function parseProviderInvoiceReference(
  input: unknown,
): ProviderInvoiceReference {
  return decodeOrThrow(
    providerInvoiceReferenceDecoder,
    input,
    'ProviderInvoiceReference',
  );
}

export function parseReconciliationSnapshotId(
  input: unknown,
): ReconciliationSnapshotId {
  return decodeOrThrow(
    reconciliationSnapshotIdDecoder,
    input,
    'ReconciliationSnapshotId',
  );
}

export function parseSubscriptionCancellationIdempotencyKey(
  input: unknown,
): SubscriptionCancellationIdempotencyKey {
  return decodeOrThrow(
    subscriptionCancellationIdempotencyKeyDecoder,
    input,
    'SubscriptionCancellationIdempotencyKey',
  );
}

export type BillingLifecycle =
  | { readonly kind: 'checkout-pending' }
  | {
      readonly kind: 'trialing';
      readonly trialStartedAt: number;
      readonly trialEndsAt: number;
    }
  | {
      readonly kind: 'active';
      readonly paidPeriodStartedAt: number;
      readonly paidThrough: number;
    }
  | {
      readonly kind: 'delinquent';
      readonly reason: 'payment-failed' | 'payment-action-required';
      readonly since: number;
      readonly invoiceReference: ProviderInvoiceReference;
    }
  | { readonly kind: 'cancelled'; readonly cancelledAt: number };

export type BillingSubscriptionFacts = {
  readonly subscriptionId: BillingSubscriptionId;
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly version: BillingVersion;
  readonly lifecycle: BillingLifecycle;
  readonly paymentMethodReady: boolean;
  readonly cancelAt: number | null;
  readonly updatedAt: number;
};

export type BeginCheckoutCommand = {
  readonly subscriptionId: BillingSubscriptionId;
  readonly checkoutIntentId: CheckoutIntentId;
  readonly provider: BillingProvider;
  readonly createdAt: number;
};

export type RecordCheckoutOpenedCommand = {
  readonly subscriptionId: BillingSubscriptionId;
  readonly checkoutIntentId: CheckoutIntentId;
  readonly providerCheckoutReference: ProviderCheckoutReference;
  readonly openedAt: number;
};

type VerifiedProviderFactBase = {
  readonly subscriptionId: BillingSubscriptionId;
  readonly provider: BillingProvider;
  readonly eventId: ProviderEventId;
  readonly providerCustomerReference: ProviderCustomerReference;
  readonly providerSubscriptionReference: ProviderSubscriptionReference;
  readonly occurredAt: number;
  readonly recordedAt: number;
};

export type VerifiedProviderFact =
  | (VerifiedProviderFactBase & {
      readonly kind: 'trial-started';
      readonly trialStartedAt: number;
      readonly trialEndsAt: number;
    })
  | (VerifiedProviderFactBase & {
      readonly kind: 'payment-method-updated';
    })
  | (VerifiedProviderFactBase & {
      readonly kind: 'invoice-paid';
      readonly invoiceReference: ProviderInvoiceReference;
      readonly paidPeriodStartedAt: number;
      readonly paidPeriodEndsAt: number;
    })
  | (VerifiedProviderFactBase & {
      readonly kind: 'invoice-payment-failed';
      readonly invoiceReference: ProviderInvoiceReference;
    })
  | (VerifiedProviderFactBase & {
      readonly kind: 'invoice-payment-action-required';
      readonly invoiceReference: ProviderInvoiceReference;
    })
  | (VerifiedProviderFactBase & {
      readonly kind: 'cancellation-scheduled';
      readonly cancelAt: number;
    })
  | (VerifiedProviderFactBase & {
      readonly kind: 'subscription-cancelled';
      readonly cancelledAt: number;
    });

export type ReconciliationSnapshot = {
  readonly snapshotId: ReconciliationSnapshotId;
  readonly subscriptionId: BillingSubscriptionId;
  readonly provider: BillingProvider;
  readonly providerCustomerReference: ProviderCustomerReference;
  readonly providerSubscriptionReference: ProviderSubscriptionReference;
  readonly observedAt: number;
  readonly recordedAt: number;
  readonly paymentMethodReady: boolean;
  readonly paymentMethodUpdatedAt: number;
  readonly trial: {
    readonly startedAt: number;
    readonly endsAt: number;
    readonly observedAt: number;
  } | null;
  readonly latestPaidInvoice: {
    readonly invoiceReference: ProviderInvoiceReference;
    readonly paidAt: number;
    readonly periodStartedAt: number;
    readonly periodEndsAt: number;
  } | null;
  readonly delinquency: {
    readonly reason: 'payment-failed' | 'payment-action-required';
    readonly invoiceReference: ProviderInvoiceReference;
    readonly occurredAt: number;
  } | null;
  readonly cancelAt: number | null;
  readonly cancellationUpdatedAt: number;
  readonly cancelledAt: number | null;
};

export type BillingCommandResult =
  | { readonly kind: 'applied'; readonly facts: BillingSubscriptionFacts }
  | { readonly kind: 'replayed'; readonly facts: BillingSubscriptionFacts }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'owner-mismatch'
        | 'not-found'
        | 'identifier-conflict'
        | 'provider-mismatch'
        | 'mapping-mismatch'
        | 'invalid-transition'
        | 'cas-conflict';
    };

export type ProviderFactResult =
  | { readonly kind: 'applied'; readonly facts: BillingSubscriptionFacts }
  | {
      readonly kind: 'ignored';
      readonly reason: 'stale' | 'terminal' | 'no-change';
      readonly facts: BillingSubscriptionFacts;
    }
  | { readonly kind: 'duplicate'; readonly facts: BillingSubscriptionFacts }
  | Extract<BillingCommandResult, { kind: 'rejected' }>;

export type SubscriptionCancellationCommand = BillingOwnerScope & {
  readonly idempotencyKey: SubscriptionCancellationIdempotencyKey;
  readonly requestedAt: number;
};

type SubscriptionCancellationFailure =
  | {
      readonly kind: 'retryable-failure';
      readonly reason:
        | 'provider-unavailable'
        | 'malformed-provider-response'
        | 'provider-result-mismatch';
    }
  | {
      readonly kind: 'terminal-failure';
      readonly reason:
        | 'invalid-command'
        | 'invalid-subscription-state'
        | 'owner-mismatch'
        | 'subscription-not-found'
        | 'provider-not-linked'
        | 'provider-terminal';
    };

export type PeriodEndSubscriptionCancellationResult =
  | {
      readonly kind: 'confirmed';
      readonly outcome: 'scheduled' | 'already-cancelled';
      readonly confirmedAt: number;
      readonly accessEndsAt: number;
    }
  | SubscriptionCancellationFailure;

export type ImmediateSubscriptionCancellationResult =
  | {
      readonly kind: 'confirmed';
      readonly outcome: 'cancelled' | 'already-cancelled';
      readonly confirmedAt: number;
      readonly accessEndsAt: number;
    }
  | SubscriptionCancellationFailure;

export const MAXIMUM_JAVASCRIPT_DATE_TIMESTAMP_MS =
  8_640_000_000_000_000 as const;

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const displayTimestampDecoder = safeIntegerDecoder({
  minimum: 0,
  maximum: MAXIMUM_JAVASCRIPT_DATE_TIMESTAMP_MS,
});

export const subscriptionCancellationCommandDecoder: Decoder<SubscriptionCancellationCommand> =
  objectDecoder({
    accountId: accountIdDecoder,
    vaultId: vaultIdDecoder,
    idempotencyKey: subscriptionCancellationIdempotencyKeyDecoder,
    requestedAt: timestampDecoder,
  });

const subscriptionCancellationFailureDecoder: Decoder<SubscriptionCancellationFailure> =
  unionDecoder(
    objectDecoder({
      kind: literalDecoder('retryable-failure'),
      reason: unionDecoder(
        literalDecoder('provider-unavailable'),
        literalDecoder('malformed-provider-response'),
        literalDecoder('provider-result-mismatch'),
      ),
    }),
    objectDecoder({
      kind: literalDecoder('terminal-failure'),
      reason: unionDecoder(
        literalDecoder('invalid-command'),
        literalDecoder('invalid-subscription-state'),
        literalDecoder('owner-mismatch'),
        literalDecoder('subscription-not-found'),
        literalDecoder('provider-not-linked'),
        literalDecoder('provider-terminal'),
      ),
    }),
  );

export const periodEndSubscriptionCancellationResultDecoder: Decoder<PeriodEndSubscriptionCancellationResult> =
  unionDecoder(
    objectDecoder({
      kind: literalDecoder('confirmed'),
      outcome: unionDecoder(
        literalDecoder('scheduled'),
        literalDecoder('already-cancelled'),
      ),
      confirmedAt: timestampDecoder,
      accessEndsAt: displayTimestampDecoder,
    }),
    subscriptionCancellationFailureDecoder,
  );

export const immediateSubscriptionCancellationResultDecoder: Decoder<ImmediateSubscriptionCancellationResult> =
  unionDecoder(
    objectDecoder({
      kind: literalDecoder('confirmed'),
      outcome: unionDecoder(
        literalDecoder('cancelled'),
        literalDecoder('already-cancelled'),
      ),
      confirmedAt: timestampDecoder,
      accessEndsAt: displayTimestampDecoder,
    }),
    subscriptionCancellationFailureDecoder,
  );

export type PeriodEndSubscriptionCancellationPort = {
  scheduleSubscriptionCancellation(
    command: SubscriptionCancellationCommand,
  ): Promise<PeriodEndSubscriptionCancellationResult>;
};

export type ImmediateSubscriptionCancellationPort = {
  cancelSubscriptionImmediately(
    command: SubscriptionCancellationCommand,
  ): Promise<ImmediateSubscriptionCancellationResult>;
};

export type SubscriptionCancellationPort =
  PeriodEndSubscriptionCancellationPort & ImmediateSubscriptionCancellationPort;

export type BillingApi = {
  beginCheckout(
    context: VaultContext,
    command: BeginCheckoutCommand,
  ): Promise<BillingCommandResult>;
  recordCheckoutOpened(
    context: VaultContext,
    command: RecordCheckoutOpenedCommand,
  ): Promise<BillingCommandResult>;
  ingestVerifiedProviderFact(
    fact: VerifiedProviderFact,
  ): Promise<ProviderFactResult>;
  reconcileVerifiedSnapshot(
    snapshot: ReconciliationSnapshot,
  ): Promise<ProviderFactResult>;
  readSubscription(
    context: VaultContext,
  ): Promise<BillingSubscriptionFacts | undefined>;
};
