import { decodeOrThrow } from '../../lib/codec/core';
import type {
  AccountId,
  VaultContext,
  VaultId,
} from '../../lib/domain/identity';
import type { D1DatabaseBinding } from '../../db/d1-types';
import type { IdentityVaultControlPlane } from '../control-plane/public';
import type { BillingSubscriptionRecord } from './core';
import type {
  AtomicCommitResult,
  BillingRepository,
  CheckoutCreateResult,
  CheckoutOpenResult,
  ReceiptRecordResult,
} from './ports';
import {
  billingSubscriptionRowDecoder,
  checkoutIntentRowDecoder,
  mapBillingSubscriptionRow,
  mapCheckoutIntentRow,
  mapProviderEventReceiptRow,
  mapReconciliationCheckpointRow,
  providerEventReceiptRowDecoder,
  reconciliationCheckpointRowDecoder,
  type CheckoutIntentRecord,
  type ProviderEventReceipt,
  type ReconciliationCheckpoint,
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

const subscriptionColumns = `subscription_id, account_id, vault_id, provider,
  provider_customer_ref, provider_subscription_ref, version, status,
  payment_method_ready, payment_method_updated_at, trial_started_at,
  trial_ends_at, trial_observed_at, paid_period_started_at,
  paid_period_ends_at, last_paid_at, last_paid_invoice_ref,
  delinquency_reason, delinquency_since, delinquency_invoice_ref, cancel_at,
  cancellation_updated_at, cancelled_at, last_reconciled_at, created_at,
  updated_at`;

const updateSubscriptionSql = `UPDATE billing_subscriptions SET
  provider_customer_ref = ?, provider_subscription_ref = ?, version = ?,
  status = ?, payment_method_ready = ?, payment_method_updated_at = ?,
  trial_started_at = ?, trial_ends_at = ?, trial_observed_at = ?,
  paid_period_started_at = ?, paid_period_ends_at = ?, last_paid_at = ?,
  last_paid_invoice_ref = ?, delinquency_reason = ?, delinquency_since = ?,
  delinquency_invoice_ref = ?, cancel_at = ?,
  cancellation_updated_at = ?, cancelled_at = ?, last_reconciled_at = ?,
  updated_at = ?
  WHERE subscription_id = ? AND version = ? AND provider = ?
    AND (provider_customer_ref IS NULL OR provider_customer_ref = ?)
    AND (provider_subscription_ref IS NULL OR provider_subscription_ref = ?)`;

export class D1BillingRepository implements BillingRepository {
  constructor(private readonly database: D1DatabaseBinding) {}

  async findByOwner(
    context: VaultContext,
  ): Promise<BillingSubscriptionRecord | undefined> {
    return this.findByOwnerIds(context.accountId, context.vaultId);
  }

  private async findByOwnerIds(
    accountId: AccountId,
    vaultId: VaultId,
  ): Promise<BillingSubscriptionRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT ${subscriptionColumns} FROM billing_subscriptions
         WHERE account_id = ? AND vault_id = ?`,
      )
      .bind(accountId, vaultId)
      .first();
    return this.mapSubscription(input);
  }

  async findById(
    subscriptionId: BillingSubscriptionId,
  ): Promise<BillingSubscriptionRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT ${subscriptionColumns} FROM billing_subscriptions
         WHERE subscription_id = ?`,
      )
      .bind(subscriptionId)
      .first();
    return this.mapSubscription(input);
  }

  async findByProviderMapping(input: {
    readonly provider: BillingProvider;
    readonly customerReference: ProviderCustomerReference;
    readonly subscriptionReference: ProviderSubscriptionReference;
  }): Promise<BillingSubscriptionRecord | undefined> {
    const value: unknown = await this.database
      .prepare(
        `SELECT ${subscriptionColumns} FROM billing_subscriptions
         WHERE provider = ?
           AND (provider_customer_ref = ? OR provider_subscription_ref = ?)`,
      )
      .bind(
        input.provider,
        input.customerReference,
        input.subscriptionReference,
      )
      .first();
    return this.mapSubscription(value);
  }

  async findCheckoutIntent(
    checkoutIntentId: CheckoutIntentId,
  ): Promise<CheckoutIntentRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT checkout_intent_id, subscription_id, provider,
          provider_checkout_ref, status, created_at, opened_at
         FROM billing_checkout_intents WHERE checkout_intent_id = ?`,
      )
      .bind(checkoutIntentId)
      .first();
    return input === null
      ? undefined
      : mapCheckoutIntentRow(
          decodeOrThrow(
            checkoutIntentRowDecoder,
            input,
            'D1 Billing checkout intent row',
          ),
        );
  }

  async findCheckoutByProviderReference(
    provider: BillingProvider,
    reference: ProviderCheckoutReference,
  ): Promise<CheckoutIntentRecord | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT checkout_intent_id, subscription_id, provider,
          provider_checkout_ref, status, created_at, opened_at
         FROM billing_checkout_intents
         WHERE provider = ? AND provider_checkout_ref = ?`,
      )
      .bind(provider, reference)
      .first();
    return input === null
      ? undefined
      : mapCheckoutIntentRow(
          decodeOrThrow(
            checkoutIntentRowDecoder,
            input,
            'D1 Billing checkout intent row',
          ),
        );
  }

  async createCheckout(input: {
    readonly record: BillingSubscriptionRecord;
    readonly intent: CheckoutIntentRecord;
  }): Promise<CheckoutCreateResult> {
    const row = subscriptionBindings(input.record);
    try {
      await this.database.batch([
        this.database
          .prepare(
            `INSERT INTO billing_subscriptions(${subscriptionColumns})
             VALUES (${placeholders(row.length)})`,
          )
          .bind(...row),
        this.database
          .prepare(
            `INSERT INTO billing_checkout_intents(
              checkout_intent_id, subscription_id, provider,
              provider_checkout_ref, status, created_at, opened_at
            ) VALUES (?, ?, ?, NULL, 'created', ?, NULL)`,
          )
          .bind(
            input.intent.checkoutIntentId,
            input.intent.subscriptionId,
            input.intent.provider,
            input.intent.createdAt,
          ),
      ]);
      return { kind: 'created' };
    } catch (error: unknown) {
      const [record, intent] = await Promise.all([
        this.findByOwnerIds(input.record.accountId, input.record.vaultId),
        this.findCheckoutIntent(input.intent.checkoutIntentId),
      ]);
      if (record !== undefined || intent !== undefined) {
        return { kind: 'existing', record, intent };
      }
      throw error;
    }
  }

  async openCheckout(input: {
    readonly context: VaultContext;
    readonly intent: CheckoutIntentRecord;
  }): Promise<CheckoutOpenResult> {
    const result = await this.database
      .prepare(
        `UPDATE billing_checkout_intents SET
          provider_checkout_ref = ?, status = 'opened', opened_at = ?
         WHERE checkout_intent_id = ? AND subscription_id = ?
           AND status = 'created'
           AND EXISTS (
             SELECT 1 FROM billing_subscriptions subscription
             WHERE subscription.subscription_id = billing_checkout_intents.subscription_id
               AND subscription.account_id = ? AND subscription.vault_id = ?
           )`,
      )
      .bind(
        input.intent.providerCheckoutReference,
        input.intent.openedAt,
        input.intent.checkoutIntentId,
        input.intent.subscriptionId,
        input.context.accountId,
        input.context.vaultId,
      )
      .run();
    if (result.meta.changes === 1) return { kind: 'applied' };
    const existing = await this.findCheckoutIntent(
      input.intent.checkoutIntentId,
    );
    return existing !== undefined &&
      existing.subscriptionId === input.intent.subscriptionId &&
      existing.providerCheckoutReference ===
        input.intent.providerCheckoutReference &&
      existing.status === 'opened'
      ? { kind: 'replayed' }
      : { kind: 'conflict' };
  }

  async findProviderEventReceipt(
    provider: BillingProvider,
    eventId: ProviderEventId,
  ): Promise<ProviderEventReceipt | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT provider, provider_event_id, subscription_id, fact_kind,
          outcome, occurred_at, applied_version, recorded_at
         FROM billing_provider_event_receipts
         WHERE provider = ? AND provider_event_id = ?`,
      )
      .bind(provider, eventId)
      .first();
    return input === null
      ? undefined
      : mapProviderEventReceiptRow(
          decodeOrThrow(
            providerEventReceiptRowDecoder,
            input,
            'D1 Billing provider event receipt row',
          ),
        );
  }

  async commitProviderFact(input: {
    readonly expectedRecord: BillingSubscriptionRecord;
    readonly nextRecord: BillingSubscriptionRecord;
    readonly receipt: ProviderEventReceipt;
  }): Promise<AtomicCommitResult> {
    const statements = await this.database.batch([
      this.subscriptionUpdate(
        input.expectedRecord,
        input.nextRecord,
        `AND NOT EXISTS (
          SELECT 1 FROM billing_provider_event_receipts
          WHERE provider = ? AND provider_event_id = ?
        )`,
        [input.receipt.provider, input.receipt.eventId],
      ),
      this.database
        .prepare(
          `INSERT INTO billing_provider_event_receipts(
            provider, provider_event_id, subscription_id, fact_kind, outcome,
            occurred_at, applied_version, recorded_at
          ) SELECT ?, ?, ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
        )
        .bind(...receiptBindings(input.receipt)),
    ]);
    if (statementChanges(statements, 0) === 1) return { kind: 'applied' };
    return (await this.findProviderEventReceipt(
      input.receipt.provider,
      input.receipt.eventId,
    )) === undefined
      ? { kind: 'conflict' }
      : { kind: 'duplicate' };
  }

  async recordIgnoredProviderFact(
    receipt: ProviderEventReceipt,
  ): Promise<ReceiptRecordResult> {
    const result = await this.database
      .prepare(
        `INSERT INTO billing_provider_event_receipts(
          provider, provider_event_id, subscription_id, fact_kind, outcome,
          occurred_at, applied_version, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, provider_event_id) DO NOTHING`,
      )
      .bind(...receiptBindings(receipt))
      .run();
    return result.meta.changes === 1
      ? { kind: 'recorded' }
      : { kind: 'duplicate' };
  }

  async findReconciliationCheckpoint(
    provider: BillingProvider,
    snapshotId: ReconciliationSnapshotId,
  ): Promise<ReconciliationCheckpoint | undefined> {
    const input: unknown = await this.database
      .prepare(
        `SELECT provider, snapshot_id, subscription_id, observed_at,
          applied_version, recorded_at
         FROM billing_reconciliation_checkpoints
         WHERE provider = ? AND snapshot_id = ?`,
      )
      .bind(provider, snapshotId)
      .first();
    return input === null
      ? undefined
      : mapReconciliationCheckpointRow(
          decodeOrThrow(
            reconciliationCheckpointRowDecoder,
            input,
            'D1 Billing reconciliation checkpoint row',
          ),
        );
  }

  async commitReconciliation(input: {
    readonly expectedRecord: BillingSubscriptionRecord;
    readonly nextRecord: BillingSubscriptionRecord;
    readonly checkpoint: ReconciliationCheckpoint;
  }): Promise<AtomicCommitResult> {
    const statements = await this.database.batch([
      this.subscriptionUpdate(
        input.expectedRecord,
        input.nextRecord,
        `AND NOT EXISTS (
          SELECT 1 FROM billing_reconciliation_checkpoints
          WHERE provider = ? AND snapshot_id = ?
        )`,
        [input.checkpoint.provider, input.checkpoint.snapshotId],
      ),
      this.database
        .prepare(
          `INSERT INTO billing_reconciliation_checkpoints(
            provider, snapshot_id, subscription_id, observed_at,
            applied_version, recorded_at
          ) SELECT ?, ?, ?, ?, ?, ? WHERE changes() = 1`,
        )
        .bind(...checkpointBindings(input.checkpoint)),
    ]);
    if (statementChanges(statements, 0) === 1) return { kind: 'applied' };
    return (await this.findReconciliationCheckpoint(
      input.checkpoint.provider,
      input.checkpoint.snapshotId,
    )) === undefined
      ? { kind: 'conflict' }
      : { kind: 'duplicate' };
  }

  async recordIgnoredReconciliation(
    checkpoint: ReconciliationCheckpoint,
  ): Promise<ReceiptRecordResult> {
    const result = await this.database
      .prepare(
        `INSERT INTO billing_reconciliation_checkpoints(
          provider, snapshot_id, subscription_id, observed_at,
          applied_version, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(provider, snapshot_id) DO NOTHING`,
      )
      .bind(...checkpointBindings(checkpoint))
      .run();
    return result.meta.changes === 1
      ? { kind: 'recorded' }
      : { kind: 'duplicate' };
  }

  private mapSubscription(
    input: unknown,
  ): BillingSubscriptionRecord | undefined {
    return input === null
      ? undefined
      : mapBillingSubscriptionRow(
          decodeOrThrow(
            billingSubscriptionRowDecoder,
            input,
            'D1 Billing subscription row',
          ),
        );
  }

  private subscriptionUpdate(
    expected: BillingSubscriptionRecord,
    next: BillingSubscriptionRecord,
    additionalWhere: string,
    additionalBindings: readonly (string | number)[],
  ) {
    return this.database
      .prepare(`${updateSubscriptionSql} ${additionalWhere}`)
      .bind(
        ...subscriptionUpdateBindings(next),
        expected.subscriptionId,
        expected.version,
        expected.provider,
        next.providerCustomerReference,
        next.providerSubscriptionReference,
        ...additionalBindings,
      );
  }
}

export function createD1BillingApi(
  database: D1DatabaseBinding,
  controlPlane: IdentityVaultControlPlane,
): BillingApi {
  return createBillingApi({
    repository: new D1BillingRepository(database),
    ownership: {
      async owns(context) {
        const owner = await controlPlane.findPersonalAccount(context.accountId);
        return (
          owner !== undefined &&
          owner.account.accountId === context.accountId &&
          owner.vault.vaultId === context.vaultId
        );
      },
    },
  });
}

function subscriptionBindings(
  record: BillingSubscriptionRecord,
): readonly (string | number | null)[] {
  return [
    record.subscriptionId,
    record.accountId,
    record.vaultId,
    record.provider,
    record.providerCustomerReference,
    record.providerSubscriptionReference,
    record.version,
    ...subscriptionMutableBindings(record),
    record.createdAt,
    record.updatedAt,
  ];
}

function subscriptionUpdateBindings(
  record: BillingSubscriptionRecord,
): readonly (string | number | null)[] {
  return [
    record.providerCustomerReference,
    record.providerSubscriptionReference,
    record.version,
    ...subscriptionMutableBindings(record),
    record.updatedAt,
  ];
}

function subscriptionMutableBindings(
  record: BillingSubscriptionRecord,
): readonly (string | number | null)[] {
  const lifecycle = lifecycleBindings(record);
  return [
    lifecycle.status,
    record.paymentMethodReady ? 1 : 0,
    record.paymentMethodUpdatedAt,
    lifecycle.trialStartedAt,
    lifecycle.trialEndsAt,
    record.trialObservedAt,
    lifecycle.paidPeriodStartedAt,
    lifecycle.paidPeriodEndsAt,
    record.lastPaidAt,
    record.lastPaidInvoiceReference,
    lifecycle.delinquencyReason,
    lifecycle.delinquencySince,
    lifecycle.delinquencyInvoiceReference,
    record.cancelAt,
    record.cancellationUpdatedAt,
    lifecycle.cancelledAt,
    record.lastReconciledAt,
  ];
}

function lifecycleBindings(record: BillingSubscriptionRecord): {
  readonly status: BillingSubscriptionRecord['lifecycle']['kind'];
  readonly trialStartedAt: number | null;
  readonly trialEndsAt: number | null;
  readonly paidPeriodStartedAt: number | null;
  readonly paidPeriodEndsAt: number | null;
  readonly delinquencyReason: string | null;
  readonly delinquencySince: number | null;
  readonly delinquencyInvoiceReference: string | null;
  readonly cancelledAt: number | null;
} {
  switch (record.lifecycle.kind) {
    case 'checkout-pending':
      return emptyLifecycle('checkout-pending');
    case 'trialing':
      return {
        ...emptyLifecycle('trialing'),
        trialStartedAt: record.lifecycle.trialStartedAt,
        trialEndsAt: record.lifecycle.trialEndsAt,
      };
    case 'active':
      return {
        ...emptyLifecycle('active'),
        paidPeriodStartedAt: record.lifecycle.paidPeriodStartedAt,
        paidPeriodEndsAt: record.lifecycle.paidThrough,
      };
    case 'delinquent':
      return {
        ...emptyLifecycle('delinquent'),
        delinquencyReason: record.lifecycle.reason,
        delinquencySince: record.lifecycle.since,
        delinquencyInvoiceReference: record.lifecycle.invoiceReference,
      };
    case 'cancelled':
      return {
        ...emptyLifecycle('cancelled'),
        cancelledAt: record.lifecycle.cancelledAt,
      };
  }
}

function emptyLifecycle(
  status: BillingSubscriptionRecord['lifecycle']['kind'],
) {
  return {
    status,
    trialStartedAt: null,
    trialEndsAt: null,
    paidPeriodStartedAt: null,
    paidPeriodEndsAt: null,
    delinquencyReason: null,
    delinquencySince: null,
    delinquencyInvoiceReference: null,
    cancelledAt: null,
  };
}

function receiptBindings(
  receipt: ProviderEventReceipt,
): readonly (string | number)[] {
  return [
    receipt.provider,
    receipt.eventId,
    receipt.subscriptionId,
    receipt.factKind,
    receipt.outcome,
    receipt.occurredAt,
    receipt.appliedVersion,
    receipt.recordedAt,
  ];
}

function checkpointBindings(
  checkpoint: ReconciliationCheckpoint,
): readonly (string | number)[] {
  return [
    checkpoint.provider,
    checkpoint.snapshotId,
    checkpoint.subscriptionId,
    checkpoint.observedAt,
    checkpoint.appliedVersion,
    checkpoint.recordedAt,
  ];
}

function placeholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function statementChanges(
  statements: readonly D1Result<unknown>[],
  index: number,
): number {
  const result = statements[index];
  if (result === undefined) throw new Error('missing D1 batch result');
  return result.meta.changes;
}
