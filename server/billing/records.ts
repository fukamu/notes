import {
  BoundaryDecodeError,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  unionDecoder,
  type InferDecoder,
} from '../../lib/codec/core';
import { accountIdDecoder, vaultIdDecoder } from '../../lib/domain/identity';
import type { BillingSubscriptionRecord } from './core';
import {
  billingProviderDecoder,
  billingSubscriptionIdDecoder,
  billingVersionDecoder,
  checkoutIntentIdDecoder,
  providerCheckoutReferenceDecoder,
  providerCustomerReferenceDecoder,
  providerEventIdDecoder,
  providerInvoiceReferenceDecoder,
  providerSubscriptionReferenceDecoder,
  reconciliationSnapshotIdDecoder,
  type BillingProvider,
  type BillingSubscriptionId,
  type BillingVersion,
  type CheckoutIntentId,
  type ProviderCheckoutReference,
  type ProviderEventId,
  type ReconciliationSnapshotId,
  type VerifiedProviderFact,
} from './public';

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const sqliteBooleanDecoder = refineDecoder(
  safeIntegerDecoder({ minimum: 0, maximum: 1 }),
  (value) => value === 0 || value === 1,
  'expected SQLite boolean',
);
const lifecycleStatusDecoder = unionDecoder(
  literalDecoder('checkout-pending'),
  literalDecoder('trialing'),
  literalDecoder('active'),
  literalDecoder('delinquent'),
  literalDecoder('cancelled'),
);
const delinquencyReasonDecoder = nullableDecoder(
  unionDecoder(
    literalDecoder('payment-failed'),
    literalDecoder('payment-action-required'),
  ),
);

export const billingSubscriptionRowDecoder = objectDecoder({
  subscription_id: billingSubscriptionIdDecoder,
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  provider: billingProviderDecoder,
  provider_customer_ref: nullableDecoder(providerCustomerReferenceDecoder),
  provider_subscription_ref: nullableDecoder(
    providerSubscriptionReferenceDecoder,
  ),
  version: billingVersionDecoder,
  status: lifecycleStatusDecoder,
  payment_method_ready: sqliteBooleanDecoder,
  payment_method_updated_at: nullableDecoder(timestampDecoder),
  trial_started_at: nullableDecoder(timestampDecoder),
  trial_ends_at: nullableDecoder(timestampDecoder),
  trial_observed_at: nullableDecoder(timestampDecoder),
  paid_period_started_at: nullableDecoder(timestampDecoder),
  paid_period_ends_at: nullableDecoder(timestampDecoder),
  last_paid_at: nullableDecoder(timestampDecoder),
  last_paid_invoice_ref: nullableDecoder(providerInvoiceReferenceDecoder),
  delinquency_reason: delinquencyReasonDecoder,
  delinquency_since: nullableDecoder(timestampDecoder),
  delinquency_invoice_ref: nullableDecoder(providerInvoiceReferenceDecoder),
  cancel_at: nullableDecoder(timestampDecoder),
  cancellation_updated_at: nullableDecoder(timestampDecoder),
  cancelled_at: nullableDecoder(timestampDecoder),
  last_reconciled_at: nullableDecoder(timestampDecoder),
  created_at: timestampDecoder,
  updated_at: timestampDecoder,
});

export const checkoutIntentRowDecoder = objectDecoder({
  checkout_intent_id: checkoutIntentIdDecoder,
  subscription_id: billingSubscriptionIdDecoder,
  provider: billingProviderDecoder,
  provider_checkout_ref: nullableDecoder(providerCheckoutReferenceDecoder),
  status: unionDecoder(literalDecoder('created'), literalDecoder('opened')),
  created_at: timestampDecoder,
  opened_at: nullableDecoder(timestampDecoder),
});

export const providerEventReceiptRowDecoder = objectDecoder({
  provider: billingProviderDecoder,
  provider_event_id: providerEventIdDecoder,
  subscription_id: billingSubscriptionIdDecoder,
  fact_kind: unionDecoder(
    literalDecoder('trial-started'),
    literalDecoder('payment-method-updated'),
    literalDecoder('invoice-paid'),
    literalDecoder('invoice-payment-failed'),
    literalDecoder('invoice-payment-action-required'),
    literalDecoder('cancellation-scheduled'),
    literalDecoder('subscription-cancelled'),
  ),
  outcome: unionDecoder(literalDecoder('applied'), literalDecoder('ignored')),
  occurred_at: timestampDecoder,
  applied_version: billingVersionDecoder,
  recorded_at: timestampDecoder,
});

export const reconciliationCheckpointRowDecoder = objectDecoder({
  provider: billingProviderDecoder,
  snapshot_id: reconciliationSnapshotIdDecoder,
  subscription_id: billingSubscriptionIdDecoder,
  observed_at: timestampDecoder,
  applied_version: billingVersionDecoder,
  recorded_at: timestampDecoder,
});

export type BillingSubscriptionRow = InferDecoder<
  typeof billingSubscriptionRowDecoder
>;
export type CheckoutIntentRow = InferDecoder<typeof checkoutIntentRowDecoder>;
export type ProviderEventReceiptRow = InferDecoder<
  typeof providerEventReceiptRowDecoder
>;
export type ReconciliationCheckpointRow = InferDecoder<
  typeof reconciliationCheckpointRowDecoder
>;

export type CheckoutIntentRecord = {
  readonly checkoutIntentId: CheckoutIntentId;
  readonly subscriptionId: BillingSubscriptionId;
  readonly provider: BillingProvider;
  readonly providerCheckoutReference: ProviderCheckoutReference | null;
  readonly status: 'created' | 'opened';
  readonly createdAt: number;
  readonly openedAt: number | null;
};

export type ProviderEventReceipt = {
  readonly provider: BillingProvider;
  readonly eventId: ProviderEventId;
  readonly subscriptionId: BillingSubscriptionId;
  readonly factKind: VerifiedProviderFact['kind'];
  readonly outcome: 'applied' | 'ignored';
  readonly occurredAt: number;
  readonly appliedVersion: BillingVersion;
  readonly recordedAt: number;
};

export type ReconciliationCheckpoint = {
  readonly provider: BillingProvider;
  readonly snapshotId: ReconciliationSnapshotId;
  readonly subscriptionId: BillingSubscriptionId;
  readonly observedAt: number;
  readonly appliedVersion: BillingVersion;
  readonly recordedAt: number;
};

export function mapBillingSubscriptionRow(
  row: BillingSubscriptionRow,
): BillingSubscriptionRecord {
  const lifecycle = mapLifecycle(row);
  if (
    row.created_at > row.updated_at ||
    (row.provider_customer_ref === null) !==
      (row.provider_subscription_ref === null) ||
    (row.last_paid_at === null) !== (row.last_paid_invoice_ref === null)
  ) {
    invalidBillingRow('inconsistent subscription metadata');
  }
  return {
    subscriptionId: row.subscription_id,
    accountId: row.account_id,
    vaultId: row.vault_id,
    provider: row.provider,
    providerCustomerReference: row.provider_customer_ref,
    providerSubscriptionReference: row.provider_subscription_ref,
    version: row.version,
    lifecycle,
    paymentMethodReady: row.payment_method_ready === 1,
    paymentMethodUpdatedAt: row.payment_method_updated_at,
    trialObservedAt: row.trial_observed_at,
    lastPaidAt: row.last_paid_at,
    lastPaidInvoiceReference: row.last_paid_invoice_ref,
    lastDelinquencyAt: row.delinquency_since,
    cancellationUpdatedAt: row.cancellation_updated_at,
    cancelAt: row.cancel_at,
    lastReconciledAt: row.last_reconciled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapCheckoutIntentRow(
  row: CheckoutIntentRow,
): CheckoutIntentRecord {
  if (
    (row.status === 'created' &&
      (row.provider_checkout_ref !== null || row.opened_at !== null)) ||
    (row.status === 'opened' &&
      (row.provider_checkout_ref === null || row.opened_at === null))
  ) {
    invalidBillingRow('inconsistent checkout intent');
  }
  return {
    checkoutIntentId: row.checkout_intent_id,
    subscriptionId: row.subscription_id,
    provider: row.provider,
    providerCheckoutReference: row.provider_checkout_ref,
    status: row.status,
    createdAt: row.created_at,
    openedAt: row.opened_at,
  };
}

export function mapProviderEventReceiptRow(
  row: ProviderEventReceiptRow,
): ProviderEventReceipt {
  return {
    provider: row.provider,
    eventId: row.provider_event_id,
    subscriptionId: row.subscription_id,
    factKind: row.fact_kind,
    outcome: row.outcome,
    occurredAt: row.occurred_at,
    appliedVersion: row.applied_version,
    recordedAt: row.recorded_at,
  };
}

export function mapReconciliationCheckpointRow(
  row: ReconciliationCheckpointRow,
): ReconciliationCheckpoint {
  return {
    provider: row.provider,
    snapshotId: row.snapshot_id,
    subscriptionId: row.subscription_id,
    observedAt: row.observed_at,
    appliedVersion: row.applied_version,
    recordedAt: row.recorded_at,
  };
}

function mapLifecycle(row: BillingSubscriptionRow) {
  switch (row.status) {
    case 'checkout-pending':
      if (
        row.trial_started_at !== null ||
        row.trial_ends_at !== null ||
        row.paid_period_started_at !== null ||
        row.paid_period_ends_at !== null ||
        row.delinquency_reason !== null ||
        row.delinquency_since !== null ||
        row.delinquency_invoice_ref !== null ||
        row.cancelled_at !== null
      ) {
        invalidBillingRow('invalid checkout-pending lifecycle');
      }
      return { kind: 'checkout-pending' } as const;
    case 'trialing':
      if (
        row.trial_started_at === null ||
        row.trial_ends_at === null ||
        row.trial_observed_at === null ||
        row.trial_ends_at <= row.trial_started_at ||
        row.payment_method_ready !== 1 ||
        row.delinquency_reason !== null ||
        row.delinquency_since !== null ||
        row.delinquency_invoice_ref !== null ||
        row.cancelled_at !== null
      ) {
        invalidBillingRow('invalid trial lifecycle');
      }
      return {
        kind: 'trialing',
        trialStartedAt: row.trial_started_at,
        trialEndsAt: row.trial_ends_at,
      } as const;
    case 'active':
      if (
        row.paid_period_started_at === null ||
        row.paid_period_ends_at === null ||
        row.last_paid_at === null ||
        row.last_paid_invoice_ref === null ||
        row.paid_period_ends_at <= row.paid_period_started_at ||
        row.delinquency_reason !== null ||
        row.delinquency_since !== null ||
        row.delinquency_invoice_ref !== null ||
        row.cancelled_at !== null
      ) {
        invalidBillingRow('invalid active lifecycle');
      }
      return {
        kind: 'active',
        paidPeriodStartedAt: row.paid_period_started_at,
        paidThrough: row.paid_period_ends_at,
      } as const;
    case 'delinquent':
      if (
        row.delinquency_reason === null ||
        row.delinquency_since === null ||
        row.delinquency_invoice_ref === null ||
        row.cancelled_at !== null
      ) {
        invalidBillingRow('invalid delinquent lifecycle');
      }
      return {
        kind: 'delinquent',
        reason: row.delinquency_reason,
        since: row.delinquency_since,
        invoiceReference: row.delinquency_invoice_ref,
      } as const;
    case 'cancelled':
      if (row.cancelled_at === null) {
        invalidBillingRow('invalid cancelled lifecycle');
      }
      return { kind: 'cancelled', cancelledAt: row.cancelled_at } as const;
  }
}

function invalidBillingRow(reason: string): never {
  throw new BoundaryDecodeError('D1 Billing subscription row', [
    { path: [], reason },
  ]);
}
