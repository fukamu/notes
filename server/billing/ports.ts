import type { VaultContext } from '../../lib/domain/identity';
import type { BillingSubscriptionRecord } from './core';
import type { ProviderSubscriptionCancellationCommand } from './cancellation-core';
import type {
  CheckoutIntentRecord,
  ProviderEventReceipt,
  ReconciliationCheckpoint,
} from './records';
import type {
  BillingProvider,
  BillingOwnerScope,
  BillingSubscriptionId,
  CheckoutIntentId,
  ProviderCustomerReference,
  ProviderCheckoutReference,
  ProviderEventId,
  ProviderSubscriptionReference,
  ReconciliationSnapshotId,
} from './public';

export type BillingOwnershipPort = {
  owns(context: VaultContext): Promise<boolean>;
};

export type CheckoutCreateResult =
  | { readonly kind: 'created' }
  | {
      readonly kind: 'existing';
      readonly record: BillingSubscriptionRecord | undefined;
      readonly intent: CheckoutIntentRecord | undefined;
    };

export type CheckoutOpenResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'replayed' }
  | { readonly kind: 'conflict' };

export type AtomicCommitResult =
  | { readonly kind: 'applied' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'conflict' };

export type ReceiptRecordResult =
  | { readonly kind: 'recorded' }
  | { readonly kind: 'duplicate' };

export type BillingRepository = {
  findByOwner(
    context: BillingOwnerScope,
  ): Promise<BillingSubscriptionRecord | undefined>;
  findById(
    subscriptionId: BillingSubscriptionId,
  ): Promise<BillingSubscriptionRecord | undefined>;
  findByProviderMapping(input: {
    readonly provider: BillingProvider;
    readonly customerReference: ProviderCustomerReference;
    readonly subscriptionReference: ProviderSubscriptionReference;
  }): Promise<BillingSubscriptionRecord | undefined>;
  findCheckoutIntent(
    checkoutIntentId: CheckoutIntentId,
  ): Promise<CheckoutIntentRecord | undefined>;
  findCheckoutByProviderReference(
    provider: BillingProvider,
    reference: ProviderCheckoutReference,
  ): Promise<CheckoutIntentRecord | undefined>;
  createCheckout(input: {
    readonly record: BillingSubscriptionRecord;
    readonly intent: CheckoutIntentRecord;
  }): Promise<CheckoutCreateResult>;
  openCheckout(input: {
    readonly context: VaultContext;
    readonly intent: CheckoutIntentRecord;
  }): Promise<CheckoutOpenResult>;
  findProviderEventReceipt(
    provider: BillingProvider,
    eventId: ProviderEventId,
  ): Promise<ProviderEventReceipt | undefined>;
  commitProviderFact(input: {
    readonly expectedRecord: BillingSubscriptionRecord;
    readonly nextRecord: BillingSubscriptionRecord;
    readonly receipt: ProviderEventReceipt;
  }): Promise<AtomicCommitResult>;
  recordIgnoredProviderFact(
    receipt: ProviderEventReceipt,
  ): Promise<ReceiptRecordResult>;
  findReconciliationCheckpoint(
    provider: BillingProvider,
    snapshotId: ReconciliationSnapshotId,
  ): Promise<ReconciliationCheckpoint | undefined>;
  commitReconciliation(input: {
    readonly expectedRecord: BillingSubscriptionRecord;
    readonly nextRecord: BillingSubscriptionRecord;
    readonly checkpoint: ReconciliationCheckpoint;
  }): Promise<AtomicCommitResult>;
  recordIgnoredReconciliation(
    checkpoint: ReconciliationCheckpoint,
  ): Promise<ReceiptRecordResult>;
};

export type SubscriptionCancellationProviderPort = {
  cancelSubscription(
    command: ProviderSubscriptionCancellationCommand,
  ): Promise<unknown>;
};
