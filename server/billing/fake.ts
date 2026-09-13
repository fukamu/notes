import type { VaultContext } from '../../lib/domain/identity';
import type { BillingSubscriptionRecord } from './core';
import type {
  AtomicCommitResult,
  BillingRepository,
  CheckoutCreateResult,
  CheckoutOpenResult,
  ReceiptRecordResult,
} from './ports';
import type {
  CheckoutIntentRecord,
  ProviderEventReceipt,
  ReconciliationCheckpoint,
} from './records';
import { createBillingApi } from './service';
import type {
  BillingApi,
  BillingProvider,
  BillingSubscriptionId,
  CheckoutIntentId,
  ProviderCustomerReference,
  ProviderCheckoutReference,
  ProviderEventId,
  ProviderSubscriptionReference,
  ReconciliationSnapshotId,
} from './public';

export type FakeBillingInspection = {
  readonly subscriptions: readonly BillingSubscriptionRecord[];
  readonly checkoutIntents: readonly CheckoutIntentRecord[];
  readonly providerEventReceipts: readonly ProviderEventReceipt[];
  readonly reconciliationCheckpoints: readonly ReconciliationCheckpoint[];
};

export class FakeBillingRepository implements BillingRepository {
  private readonly subscriptions = new Map<
    BillingSubscriptionId,
    BillingSubscriptionRecord
  >();
  private readonly checkouts = new Map<
    CheckoutIntentId,
    CheckoutIntentRecord
  >();
  private readonly receipts = new Map<string, ProviderEventReceipt>();
  private readonly checkpoints = new Map<string, ReconciliationCheckpoint>();

  async findByOwner(
    context: VaultContext,
  ): Promise<BillingSubscriptionRecord | undefined> {
    return [...this.subscriptions.values()].find(
      (record) =>
        record.accountId === context.accountId &&
        record.vaultId === context.vaultId,
    );
  }

  async findById(
    subscriptionId: BillingSubscriptionId,
  ): Promise<BillingSubscriptionRecord | undefined> {
    return this.subscriptions.get(subscriptionId);
  }

  async findByProviderMapping(input: {
    readonly provider: BillingProvider;
    readonly customerReference: ProviderCustomerReference;
    readonly subscriptionReference: ProviderSubscriptionReference;
  }): Promise<BillingSubscriptionRecord | undefined> {
    return [...this.subscriptions.values()].find(
      (record) =>
        record.provider === input.provider &&
        (record.providerCustomerReference === input.customerReference ||
          record.providerSubscriptionReference === input.subscriptionReference),
    );
  }

  async findCheckoutIntent(
    checkoutIntentId: CheckoutIntentId,
  ): Promise<CheckoutIntentRecord | undefined> {
    return this.checkouts.get(checkoutIntentId);
  }

  async findCheckoutByProviderReference(
    provider: BillingProvider,
    reference: ProviderCheckoutReference,
  ): Promise<CheckoutIntentRecord | undefined> {
    return [...this.checkouts.values()].find(
      (intent) =>
        intent.provider === provider &&
        intent.providerCheckoutReference === reference,
    );
  }

  async createCheckout(input: {
    readonly record: BillingSubscriptionRecord;
    readonly intent: CheckoutIntentRecord;
  }): Promise<CheckoutCreateResult> {
    const owner = [...this.subscriptions.values()].find(
      (record) =>
        record.accountId === input.record.accountId &&
        record.vaultId === input.record.vaultId,
    );
    const intent = this.checkouts.get(input.intent.checkoutIntentId);
    if (owner !== undefined || intent !== undefined) {
      return { kind: 'existing', record: owner, intent };
    }
    this.subscriptions.set(input.record.subscriptionId, input.record);
    this.checkouts.set(input.intent.checkoutIntentId, input.intent);
    return { kind: 'created' };
  }

  async openCheckout(input: {
    readonly context: VaultContext;
    readonly intent: CheckoutIntentRecord;
  }): Promise<CheckoutOpenResult> {
    const current = this.checkouts.get(input.intent.checkoutIntentId);
    const subscription = this.subscriptions.get(input.intent.subscriptionId);
    if (
      current === undefined ||
      subscription === undefined ||
      subscription.accountId !== input.context.accountId ||
      subscription.vaultId !== input.context.vaultId
    ) {
      return { kind: 'conflict' };
    }
    if (current.status === 'opened') {
      return current.providerCheckoutReference ===
        input.intent.providerCheckoutReference
        ? { kind: 'replayed' }
        : { kind: 'conflict' };
    }
    this.checkouts.set(input.intent.checkoutIntentId, input.intent);
    return { kind: 'applied' };
  }

  async findProviderEventReceipt(
    provider: BillingProvider,
    eventId: ProviderEventId,
  ): Promise<ProviderEventReceipt | undefined> {
    return this.receipts.get(receiptKey(provider, eventId));
  }

  async commitProviderFact(input: {
    readonly expectedRecord: BillingSubscriptionRecord;
    readonly nextRecord: BillingSubscriptionRecord;
    readonly receipt: ProviderEventReceipt;
  }): Promise<AtomicCommitResult> {
    const key = receiptKey(input.receipt.provider, input.receipt.eventId);
    if (this.receipts.has(key)) return { kind: 'duplicate' };
    if (!this.canCommit(input.expectedRecord, input.nextRecord)) {
      return { kind: 'conflict' };
    }
    this.subscriptions.set(input.nextRecord.subscriptionId, input.nextRecord);
    this.receipts.set(key, input.receipt);
    return { kind: 'applied' };
  }

  async recordIgnoredProviderFact(
    receipt: ProviderEventReceipt,
  ): Promise<ReceiptRecordResult> {
    const key = receiptKey(receipt.provider, receipt.eventId);
    if (this.receipts.has(key)) return { kind: 'duplicate' };
    this.receipts.set(key, receipt);
    return { kind: 'recorded' };
  }

  async findReconciliationCheckpoint(
    provider: BillingProvider,
    snapshotId: ReconciliationSnapshotId,
  ): Promise<ReconciliationCheckpoint | undefined> {
    return this.checkpoints.get(checkpointKey(provider, snapshotId));
  }

  async commitReconciliation(input: {
    readonly expectedRecord: BillingSubscriptionRecord;
    readonly nextRecord: BillingSubscriptionRecord;
    readonly checkpoint: ReconciliationCheckpoint;
  }): Promise<AtomicCommitResult> {
    const key = checkpointKey(
      input.checkpoint.provider,
      input.checkpoint.snapshotId,
    );
    if (this.checkpoints.has(key)) return { kind: 'duplicate' };
    if (!this.canCommit(input.expectedRecord, input.nextRecord)) {
      return { kind: 'conflict' };
    }
    this.subscriptions.set(input.nextRecord.subscriptionId, input.nextRecord);
    this.checkpoints.set(key, input.checkpoint);
    return { kind: 'applied' };
  }

  async recordIgnoredReconciliation(
    checkpoint: ReconciliationCheckpoint,
  ): Promise<ReceiptRecordResult> {
    const key = checkpointKey(checkpoint.provider, checkpoint.snapshotId);
    if (this.checkpoints.has(key)) return { kind: 'duplicate' };
    this.checkpoints.set(key, checkpoint);
    return { kind: 'recorded' };
  }

  inspect(): FakeBillingInspection {
    return {
      subscriptions: [...this.subscriptions.values()],
      checkoutIntents: [...this.checkouts.values()],
      providerEventReceipts: [...this.receipts.values()],
      reconciliationCheckpoints: [...this.checkpoints.values()],
    };
  }

  private canCommit(
    expected: BillingSubscriptionRecord,
    next: BillingSubscriptionRecord,
  ): boolean {
    const current = this.subscriptions.get(expected.subscriptionId);
    if (
      current === undefined ||
      current.version !== expected.version ||
      next.version !== expected.version + 1
    ) {
      return false;
    }
    for (const candidate of this.subscriptions.values()) {
      if (candidate.subscriptionId === next.subscriptionId) continue;
      if (
        candidate.provider === next.provider &&
        ((next.providerCustomerReference !== null &&
          candidate.providerCustomerReference ===
            next.providerCustomerReference) ||
          (next.providerSubscriptionReference !== null &&
            candidate.providerSubscriptionReference ===
              next.providerSubscriptionReference))
      ) {
        return false;
      }
    }
    return true;
  }
}

export function createFakeBillingModule(owners: readonly VaultContext[]): {
  readonly api: BillingApi;
  readonly repository: FakeBillingRepository;
} {
  const repository = new FakeBillingRepository();
  const ownerKeys = new Set(owners.map(ownerKey));
  return {
    repository,
    api: createBillingApi({
      repository,
      ownership: {
        async owns(context) {
          return ownerKeys.has(ownerKey(context));
        },
      },
    }),
  };
}

function ownerKey(context: VaultContext): string {
  return `${context.accountId}\u0000${context.vaultId}`;
}

function receiptKey(provider: BillingProvider, eventId: ProviderEventId) {
  return `${provider}\u0000${eventId}`;
}

function checkpointKey(
  provider: BillingProvider,
  snapshotId: ReconciliationSnapshotId,
) {
  return `${provider}\u0000${snapshotId}`;
}
