import type {
  AccountId,
  VaultContext,
  VaultId,
} from '../../lib/domain/identity';
import type {
  BeginCheckoutCommand,
  BillingLifecycle,
  BillingProvider,
  BillingSubscriptionFacts,
  BillingSubscriptionId,
  BillingVersion,
  ProviderCustomerReference,
  ProviderInvoiceReference,
  ProviderSubscriptionReference,
  ReconciliationSnapshot,
  VerifiedProviderFact,
} from './public';

export const BILLING_TRIAL_DURATION_MS = 14 * 24 * 60 * 60 * 1_000;

export type BillingSubscriptionRecord = {
  readonly subscriptionId: BillingSubscriptionId;
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly provider: BillingProvider;
  readonly providerCustomerReference: ProviderCustomerReference | null;
  readonly providerSubscriptionReference: ProviderSubscriptionReference | null;
  readonly version: BillingVersion;
  readonly lifecycle: BillingLifecycle;
  readonly paymentMethodReady: boolean;
  readonly paymentMethodUpdatedAt: number | null;
  readonly trialObservedAt: number | null;
  readonly lastPaidAt: number | null;
  readonly lastPaidInvoiceReference: ProviderInvoiceReference | null;
  readonly lastDelinquencyAt: number | null;
  readonly cancellationUpdatedAt: number | null;
  readonly cancelAt: number | null;
  readonly lastReconciledAt: number | null;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type CheckoutCreationPlan =
  | { readonly kind: 'create'; readonly record: BillingSubscriptionRecord }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-transition' };

export type ProviderFactPlan =
  | {
      readonly kind: 'apply';
      readonly record: BillingSubscriptionRecord;
    }
  | {
      readonly kind: 'ignore';
      readonly reason: 'stale' | 'terminal' | 'no-change';
      readonly record: BillingSubscriptionRecord;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'provider-mismatch'
        | 'mapping-mismatch'
        | 'invalid-transition';
    };

export function planCheckoutCreation(
  context: VaultContext,
  command: BeginCheckoutCommand,
): CheckoutCreationPlan {
  if (!validTimestamp(command.createdAt)) {
    return { kind: 'rejected', reason: 'invalid-transition' };
  }
  return {
    kind: 'create',
    record: {
      subscriptionId: command.subscriptionId,
      accountId: context.accountId,
      vaultId: context.vaultId,
      provider: command.provider,
      providerCustomerReference: null,
      providerSubscriptionReference: null,
      version: nextVersion(undefined),
      lifecycle: { kind: 'checkout-pending' },
      paymentMethodReady: false,
      paymentMethodUpdatedAt: null,
      trialObservedAt: null,
      lastPaidAt: null,
      lastPaidInvoiceReference: null,
      lastDelinquencyAt: null,
      cancellationUpdatedAt: null,
      cancelAt: null,
      lastReconciledAt: null,
      createdAt: command.createdAt,
      updatedAt: command.createdAt,
    },
  };
}

export function planVerifiedProviderFact(
  current: BillingSubscriptionRecord,
  fact: VerifiedProviderFact,
): ProviderFactPlan {
  const mapping = mapProviderReferences(current, fact);
  if (mapping.kind === 'rejected') return mapping;
  if (!validFactTimeline(fact)) {
    return { kind: 'rejected', reason: 'invalid-transition' };
  }
  const mapped = mapping.record;
  if (mapped.lifecycle.kind === 'cancelled') {
    return { kind: 'ignore', reason: 'terminal', record: mapped };
  }

  switch (fact.kind) {
    case 'trial-started':
      return planTrialStarted(mapped, fact);
    case 'payment-method-updated':
      return planPaymentMethodUpdated(mapped, fact);
    case 'invoice-paid':
      return planInvoicePaid(mapped, fact);
    case 'invoice-payment-failed':
      return planDelinquency(mapped, fact, 'payment-failed');
    case 'invoice-payment-action-required':
      return planDelinquency(mapped, fact, 'payment-action-required');
    case 'cancellation-scheduled':
      return planCancellationScheduled(mapped, fact);
    case 'subscription-cancelled':
      return applyRecord(mapped, fact.recordedAt, {
        lifecycle: { kind: 'cancelled', cancelledAt: fact.cancelledAt },
        cancellationUpdatedAt: fact.occurredAt,
        cancelAt: fact.cancelledAt,
      });
  }
}

export function planReconciliationSnapshot(
  current: BillingSubscriptionRecord,
  snapshot: ReconciliationSnapshot,
): ProviderFactPlan {
  const mapping = mapProviderReferences(current, snapshot);
  if (mapping.kind === 'rejected') return mapping;
  if (!validSnapshotTimeline(snapshot)) {
    return { kind: 'rejected', reason: 'invalid-transition' };
  }
  if (mapping.record.lifecycle.kind === 'cancelled') {
    return { kind: 'ignore', reason: 'terminal', record: mapping.record };
  }
  if (
    mapping.record.lastReconciledAt !== null &&
    snapshot.observedAt <= mapping.record.lastReconciledAt
  ) {
    return { kind: 'ignore', reason: 'stale', record: mapping.record };
  }

  let next = mapping.record;
  if (snapshot.trial !== null) {
    const trial = snapshot.trial;
    if (
      next.trialObservedAt === null ||
      trial.observedAt > next.trialObservedAt
    ) {
      next = {
        ...next,
        trialObservedAt: trial.observedAt,
        lifecycle:
          next.lifecycle.kind === 'checkout-pending' ||
          next.lifecycle.kind === 'trialing'
            ? {
                kind: 'trialing',
                trialStartedAt: trial.startedAt,
                trialEndsAt: trial.endsAt,
              }
            : next.lifecycle,
      };
    }
  }
  if (
    next.paymentMethodUpdatedAt === null ||
    snapshot.paymentMethodUpdatedAt > next.paymentMethodUpdatedAt
  ) {
    next = {
      ...next,
      paymentMethodReady: snapshot.paymentMethodReady,
      paymentMethodUpdatedAt: snapshot.paymentMethodUpdatedAt,
    };
  }
  if (snapshot.latestPaidInvoice !== null) {
    next = applyPaidEvidence(next, snapshot.latestPaidInvoice);
  }
  if (snapshot.delinquency !== null) {
    next = applyDelinquencyEvidence(next, snapshot.delinquency);
  }
  if (
    next.cancellationUpdatedAt === null ||
    snapshot.cancellationUpdatedAt > next.cancellationUpdatedAt
  ) {
    next = {
      ...next,
      cancelAt: snapshot.cancelAt,
      cancellationUpdatedAt: snapshot.cancellationUpdatedAt,
    };
  }
  if (snapshot.cancelledAt !== null) {
    next = {
      ...next,
      lifecycle: {
        kind: 'cancelled',
        cancelledAt: snapshot.cancelledAt,
      },
      cancelAt: snapshot.cancelledAt,
      cancellationUpdatedAt: Math.max(
        snapshot.cancellationUpdatedAt,
        snapshot.cancelledAt,
      ),
    };
  }
  next = { ...next, lastReconciledAt: snapshot.observedAt };
  return applyRecordIfChanged(current, next, snapshot.recordedAt);
}

export function toBillingSubscriptionFacts(
  record: BillingSubscriptionRecord,
): BillingSubscriptionFacts {
  return {
    subscriptionId: record.subscriptionId,
    accountId: record.accountId,
    vaultId: record.vaultId,
    version: record.version,
    lifecycle: record.lifecycle,
    paymentMethodReady: record.paymentMethodReady,
    cancelAt: record.cancelAt,
    updatedAt: record.updatedAt,
  };
}

function planTrialStarted(
  current: BillingSubscriptionRecord,
  fact: Extract<VerifiedProviderFact, { kind: 'trial-started' }>,
): ProviderFactPlan {
  if (
    current.trialObservedAt !== null &&
    fact.occurredAt <= current.trialObservedAt
  ) {
    return ignoredWithMapping(current, fact, 'stale');
  }
  if (
    current.lifecycle.kind !== 'checkout-pending' &&
    current.lifecycle.kind !== 'trialing'
  ) {
    return ignoredWithMapping(current, fact, 'stale');
  }
  return applyRecord(current, fact.recordedAt, {
    lifecycle: {
      kind: 'trialing',
      trialStartedAt: fact.trialStartedAt,
      trialEndsAt: fact.trialEndsAt,
    },
    paymentMethodReady: true,
    paymentMethodUpdatedAt: later(
      current.paymentMethodUpdatedAt,
      fact.occurredAt,
    ),
    trialObservedAt: fact.occurredAt,
  });
}

function planPaymentMethodUpdated(
  current: BillingSubscriptionRecord,
  fact: Extract<VerifiedProviderFact, { kind: 'payment-method-updated' }>,
): ProviderFactPlan {
  if (
    current.paymentMethodReady &&
    current.paymentMethodUpdatedAt !== null &&
    fact.occurredAt <= current.paymentMethodUpdatedAt
  ) {
    return ignoredWithMapping(current, fact, 'no-change');
  }
  return applyRecord(current, fact.recordedAt, {
    paymentMethodReady: true,
    paymentMethodUpdatedAt: later(
      current.paymentMethodUpdatedAt,
      fact.occurredAt,
    ),
  });
}

function planInvoicePaid(
  current: BillingSubscriptionRecord,
  fact: Extract<VerifiedProviderFact, { kind: 'invoice-paid' }>,
): ProviderFactPlan {
  if (current.lastPaidAt !== null && fact.occurredAt <= current.lastPaidAt) {
    return ignoredWithMapping(current, fact, 'stale');
  }
  const next = applyPaidEvidence(current, {
    invoiceReference: fact.invoiceReference,
    paidAt: fact.occurredAt,
    periodStartedAt: fact.paidPeriodStartedAt,
    periodEndsAt: fact.paidPeriodEndsAt,
  });
  return applyRecordIfChanged(current, next, fact.recordedAt);
}

function planDelinquency(
  current: BillingSubscriptionRecord,
  fact: Extract<
    VerifiedProviderFact,
    { kind: 'invoice-payment-failed' | 'invoice-payment-action-required' }
  >,
  reason: 'payment-failed' | 'payment-action-required',
): ProviderFactPlan {
  if (current.lastPaidAt !== null && fact.occurredAt < current.lastPaidAt) {
    return ignoredWithMapping(current, fact, 'stale');
  }
  if (
    current.lastDelinquencyAt !== null &&
    fact.occurredAt < current.lastDelinquencyAt
  ) {
    return ignoredWithMapping(current, fact, 'stale');
  }
  return applyRecord(current, fact.recordedAt, {
    lifecycle: {
      kind: 'delinquent',
      reason,
      since: fact.occurredAt,
      invoiceReference: fact.invoiceReference,
    },
    lastDelinquencyAt: fact.occurredAt,
  });
}

function planCancellationScheduled(
  current: BillingSubscriptionRecord,
  fact: Extract<VerifiedProviderFact, { kind: 'cancellation-scheduled' }>,
): ProviderFactPlan {
  if (
    current.cancellationUpdatedAt !== null &&
    fact.occurredAt <= current.cancellationUpdatedAt
  ) {
    return ignoredWithMapping(current, fact, 'stale');
  }
  return applyRecord(current, fact.recordedAt, {
    cancelAt: fact.cancelAt,
    cancellationUpdatedAt: fact.occurredAt,
  });
}

function applyPaidEvidence(
  current: BillingSubscriptionRecord,
  paid: {
    readonly invoiceReference: ProviderInvoiceReference;
    readonly paidAt: number;
    readonly periodStartedAt: number;
    readonly periodEndsAt: number;
  },
): BillingSubscriptionRecord {
  if (current.lastPaidAt !== null && paid.paidAt <= current.lastPaidAt) {
    return current;
  }
  const newerThanDelinquency =
    current.lastDelinquencyAt === null ||
    paid.paidAt > current.lastDelinquencyAt;
  return {
    ...current,
    lifecycle: newerThanDelinquency
      ? {
          kind: 'active',
          paidPeriodStartedAt: paid.periodStartedAt,
          paidThrough: paid.periodEndsAt,
        }
      : current.lifecycle,
    lastPaidAt: paid.paidAt,
    lastPaidInvoiceReference: paid.invoiceReference,
    lastDelinquencyAt: newerThanDelinquency ? null : current.lastDelinquencyAt,
  };
}

function applyDelinquencyEvidence(
  current: BillingSubscriptionRecord,
  delinquency: {
    readonly reason: 'payment-failed' | 'payment-action-required';
    readonly invoiceReference: ProviderInvoiceReference;
    readonly occurredAt: number;
  },
): BillingSubscriptionRecord {
  if (
    (current.lastPaidAt !== null &&
      delinquency.occurredAt < current.lastPaidAt) ||
    (current.lastDelinquencyAt !== null &&
      delinquency.occurredAt < current.lastDelinquencyAt)
  ) {
    return current;
  }
  return {
    ...current,
    lifecycle: {
      kind: 'delinquent',
      reason: delinquency.reason,
      since: delinquency.occurredAt,
      invoiceReference: delinquency.invoiceReference,
    },
    lastDelinquencyAt: delinquency.occurredAt,
  };
}

function mapProviderReferences(
  current: BillingSubscriptionRecord,
  input: {
    readonly provider: BillingProvider;
    readonly providerCustomerReference: ProviderCustomerReference;
    readonly providerSubscriptionReference: ProviderSubscriptionReference;
  },
):
  | { readonly kind: 'mapped'; readonly record: BillingSubscriptionRecord }
  | {
      readonly kind: 'rejected';
      readonly reason: 'provider-mismatch' | 'mapping-mismatch';
    } {
  if (current.provider !== input.provider) {
    return { kind: 'rejected', reason: 'provider-mismatch' };
  }
  if (
    (current.providerCustomerReference !== null &&
      current.providerCustomerReference !== input.providerCustomerReference) ||
    (current.providerSubscriptionReference !== null &&
      current.providerSubscriptionReference !==
        input.providerSubscriptionReference)
  ) {
    return { kind: 'rejected', reason: 'mapping-mismatch' };
  }
  return {
    kind: 'mapped',
    record: {
      ...current,
      providerCustomerReference: input.providerCustomerReference,
      providerSubscriptionReference: input.providerSubscriptionReference,
    },
  };
}

function ignoredWithMapping(
  current: BillingSubscriptionRecord,
  fact: VerifiedProviderFact,
  reason: 'stale' | 'terminal' | 'no-change',
): ProviderFactPlan {
  const mappingChanged =
    current.providerCustomerReference === null ||
    current.providerSubscriptionReference === null;
  return mappingChanged
    ? applyRecord(current, fact.recordedAt, {})
    : { kind: 'ignore', reason, record: current };
}

function applyRecord(
  current: BillingSubscriptionRecord,
  recordedAt: number,
  changes: Partial<
    Pick<
      BillingSubscriptionRecord,
      | 'lifecycle'
      | 'paymentMethodReady'
      | 'paymentMethodUpdatedAt'
      | 'trialObservedAt'
      | 'lastPaidAt'
      | 'lastPaidInvoiceReference'
      | 'lastDelinquencyAt'
      | 'cancellationUpdatedAt'
      | 'cancelAt'
    >
  >,
): ProviderFactPlan {
  return {
    kind: 'apply',
    record: {
      ...current,
      ...changes,
      version: nextVersion(current.version),
      updatedAt: Math.max(current.updatedAt, recordedAt),
    },
  };
}

function applyRecordIfChanged(
  original: BillingSubscriptionRecord,
  candidate: BillingSubscriptionRecord,
  recordedAt: number,
): ProviderFactPlan {
  if (candidate === original) {
    return { kind: 'ignore', reason: 'no-change', record: original };
  }
  return {
    kind: 'apply',
    record: {
      ...candidate,
      version: nextVersion(original.version),
      updatedAt: Math.max(original.updatedAt, recordedAt),
    },
  };
}

function validFactTimeline(fact: VerifiedProviderFact): boolean {
  if (
    !validTimestamp(fact.occurredAt) ||
    !validTimestamp(fact.recordedAt) ||
    fact.recordedAt < fact.occurredAt
  ) {
    return false;
  }
  switch (fact.kind) {
    case 'trial-started':
      return (
        validTimestamp(fact.trialStartedAt) &&
        validTimestamp(fact.trialEndsAt) &&
        fact.trialEndsAt - fact.trialStartedAt === BILLING_TRIAL_DURATION_MS
      );
    case 'invoice-paid':
      return (
        validTimestamp(fact.paidPeriodStartedAt) &&
        validTimestamp(fact.paidPeriodEndsAt) &&
        fact.paidPeriodEndsAt > fact.paidPeriodStartedAt
      );
    case 'cancellation-scheduled':
      return validTimestamp(fact.cancelAt) && fact.cancelAt >= fact.occurredAt;
    case 'subscription-cancelled':
      return (
        validTimestamp(fact.cancelledAt) && fact.cancelledAt >= fact.occurredAt
      );
    case 'payment-method-updated':
    case 'invoice-payment-failed':
    case 'invoice-payment-action-required':
      return true;
  }
}

function validSnapshotTimeline(snapshot: ReconciliationSnapshot): boolean {
  if (
    !validTimestamp(snapshot.observedAt) ||
    !validTimestamp(snapshot.recordedAt) ||
    snapshot.recordedAt < snapshot.observedAt ||
    !validTimestamp(snapshot.paymentMethodUpdatedAt) ||
    !validTimestamp(snapshot.cancellationUpdatedAt)
  ) {
    return false;
  }
  if (
    snapshot.trial !== null &&
    (!snapshot.paymentMethodReady ||
      !validTimestamp(snapshot.trial.startedAt) ||
      !validTimestamp(snapshot.trial.endsAt) ||
      !validTimestamp(snapshot.trial.observedAt) ||
      snapshot.trial.endsAt - snapshot.trial.startedAt !==
        BILLING_TRIAL_DURATION_MS)
  ) {
    return false;
  }
  if (
    snapshot.latestPaidInvoice !== null &&
    (!validTimestamp(snapshot.latestPaidInvoice.paidAt) ||
      !validTimestamp(snapshot.latestPaidInvoice.periodStartedAt) ||
      !validTimestamp(snapshot.latestPaidInvoice.periodEndsAt) ||
      snapshot.latestPaidInvoice.periodEndsAt <=
        snapshot.latestPaidInvoice.periodStartedAt)
  ) {
    return false;
  }
  if (
    snapshot.delinquency !== null &&
    !validTimestamp(snapshot.delinquency.occurredAt)
  ) {
    return false;
  }
  return (
    (snapshot.cancelAt === null || validTimestamp(snapshot.cancelAt)) &&
    (snapshot.cancelledAt === null || validTimestamp(snapshot.cancelledAt))
  );
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function later(current: number | null, candidate: number): number {
  return current === null ? candidate : Math.max(current, candidate);
}

function nextVersion(current: BillingVersion | undefined): BillingVersion {
  const value = current === undefined ? 1 : current + 1;
  return value as BillingVersion;
}
