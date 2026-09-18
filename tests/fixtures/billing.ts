import { decodeOrThrow } from '@/lib/codec/core';
import type { VaultContext } from '@/lib/domain/identity';
import { BILLING_TRIAL_DURATION_MS } from '@/server/billing/core';
import {
  billingProviderDecoder,
  parseBillingSubscriptionId,
  parseCheckoutIntentId,
  parseProviderCheckoutReference,
  parseProviderCustomerReference,
  parseProviderEventId,
  parseProviderInvoiceReference,
  parseProviderSubscriptionReference,
  parseReconciliationSnapshotId,
  type BeginCheckoutCommand,
  type ReconciliationSnapshot,
  type VerifiedProviderFact,
} from '@/server/billing/public';
import {
  controlPlaneContext,
  controlPlaneIds,
} from '@/tests/fixtures/control-plane';

export const billingIds = {
  subscriptionA: parseBillingSubscriptionId(
    '01991f20-61d2-7000-8000-000000001601',
  ),
  subscriptionB: parseBillingSubscriptionId(
    '01991f20-61d2-7000-8000-000000001602',
  ),
  checkoutA: parseCheckoutIntentId('01991f20-61d2-7000-8000-000000001701'),
  checkoutB: parseCheckoutIntentId('01991f20-61d2-7000-8000-000000001702'),
  provider: decodeOrThrow(billingProviderDecoder, 'test-payments', 'provider'),
  customerA: parseProviderCustomerReference('customer_A'),
  customerB: parseProviderCustomerReference('customer_B'),
  providerSubscriptionA: parseProviderSubscriptionReference('subscription_A'),
  providerSubscriptionB: parseProviderSubscriptionReference('subscription_B'),
  checkoutReferenceA: parseProviderCheckoutReference('checkout_A'),
  invoice1: parseProviderInvoiceReference('invoice_1'),
  invoice2: parseProviderInvoiceReference('invoice_2'),
} as const;

export function billingContext(account: 'a' | 'b' = 'a'): VaultContext {
  if (account === 'a') return controlPlaneContext();
  return {
    accountId: controlPlaneIds.accountB,
    vaultId: controlPlaneIds.vaultB,
    sessionId: controlPlaneIds.sessionA,
    sessionEpoch: controlPlaneIds.epoch,
  };
}

export function beginCheckoutCommand(
  account: 'a' | 'b' = 'a',
): BeginCheckoutCommand {
  return {
    subscriptionId:
      account === 'a' ? billingIds.subscriptionA : billingIds.subscriptionB,
    checkoutIntentId:
      account === 'a' ? billingIds.checkoutA : billingIds.checkoutB,
    provider: billingIds.provider,
    createdAt: 1_000,
  };
}

function factBase(event: string, occurredAt: number) {
  return {
    subscriptionId: billingIds.subscriptionA,
    provider: billingIds.provider,
    eventId: parseProviderEventId(event),
    providerCustomerReference: billingIds.customerA,
    providerSubscriptionReference: billingIds.providerSubscriptionA,
    occurredAt,
    recordedAt: occurredAt + 10,
  } as const;
}

export function trialStartedFact(
  occurredAt = 2_000,
): Extract<VerifiedProviderFact, { kind: 'trial-started' }> {
  return {
    ...factBase(`event_trial_${occurredAt}`, occurredAt),
    kind: 'trial-started',
    trialStartedAt: occurredAt,
    trialEndsAt: occurredAt + BILLING_TRIAL_DURATION_MS,
  };
}

export function paymentMethodUpdatedFact(
  occurredAt = 3_000,
): Extract<VerifiedProviderFact, { kind: 'payment-method-updated' }> {
  return {
    ...factBase(`event_payment_method_${occurredAt}`, occurredAt),
    kind: 'payment-method-updated',
  };
}

export function invoicePaidFact(
  occurredAt = 4_000,
): Extract<VerifiedProviderFact, { kind: 'invoice-paid' }> {
  return {
    ...factBase(`event_paid_${occurredAt}`, occurredAt),
    kind: 'invoice-paid',
    invoiceReference:
      occurredAt < 5_000 ? billingIds.invoice1 : billingIds.invoice2,
    paidPeriodStartedAt: occurredAt,
    paidPeriodEndsAt: occurredAt + 30 * 24 * 60 * 60 * 1_000,
  };
}

export function paymentFailedFact(
  occurredAt = 5_000,
): Extract<VerifiedProviderFact, { kind: 'invoice-payment-failed' }> {
  return {
    ...factBase(`event_failed_${occurredAt}`, occurredAt),
    kind: 'invoice-payment-failed',
    invoiceReference: billingIds.invoice1,
  };
}

export function paymentActionRequiredFact(
  occurredAt = 5_000,
): Extract<VerifiedProviderFact, { kind: 'invoice-payment-action-required' }> {
  return {
    ...factBase(`event_action_${occurredAt}`, occurredAt),
    kind: 'invoice-payment-action-required',
    invoiceReference: billingIds.invoice1,
  };
}

export function cancellationScheduledFact(
  occurredAt = 8_000,
): Extract<VerifiedProviderFact, { kind: 'cancellation-scheduled' }> {
  return {
    ...factBase(`event_cancel_scheduled_${occurredAt}`, occurredAt),
    kind: 'cancellation-scheduled',
    cancelAt: occurredAt + 30 * 24 * 60 * 60 * 1_000,
  };
}

export function subscriptionCancelledFact(
  occurredAt = 9_000,
): Extract<VerifiedProviderFact, { kind: 'subscription-cancelled' }> {
  return {
    ...factBase(`event_cancelled_${occurredAt}`, occurredAt),
    kind: 'subscription-cancelled',
    cancelledAt: occurredAt,
  };
}

export function reconciliationSnapshot(
  observedAt = 8_000,
): ReconciliationSnapshot {
  return {
    snapshotId: parseReconciliationSnapshotId(`snapshot_${observedAt}`),
    subscriptionId: billingIds.subscriptionA,
    provider: billingIds.provider,
    providerCustomerReference: billingIds.customerA,
    providerSubscriptionReference: billingIds.providerSubscriptionA,
    observedAt,
    recordedAt: observedAt + 10,
    paymentMethodReady: true,
    paymentMethodUpdatedAt: observedAt - 100,
    trial: {
      startedAt: 2_000,
      endsAt: 2_000 + BILLING_TRIAL_DURATION_MS,
      observedAt: 2_000,
    },
    latestPaidInvoice: {
      invoiceReference: billingIds.invoice2,
      paidAt: observedAt - 200,
      periodStartedAt: observedAt - 200,
      periodEndsAt: observedAt + 30 * 24 * 60 * 60 * 1_000,
    },
    delinquency: null,
    cancelAt: null,
    cancellationUpdatedAt: observedAt - 50,
    cancelledAt: null,
  };
}
