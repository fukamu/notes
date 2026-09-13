import { describe, expect, it } from 'vitest';
import {
  planCheckoutCreation,
  planReconciliationSnapshot,
  planVerifiedProviderFact,
} from '@/server/billing/core';
import {
  beginCheckoutCommand,
  billingContext,
  cancellationScheduledFact,
  invoicePaidFact,
  paymentActionRequiredFact,
  paymentFailedFact,
  paymentMethodUpdatedFact,
  reconciliationSnapshot,
  subscriptionCancelledFact,
  trialStartedFact,
} from '@/tests/fixtures/billing';

function checkoutRecord() {
  const plan = planCheckoutCreation(billingContext(), beginCheckoutCommand());
  if (plan.kind === 'rejected') throw new Error('invalid checkout fixture');
  return plan.record;
}

function apply(
  current: ReturnType<typeof checkoutRecord>,
  fact: Parameters<typeof planVerifiedProviderFact>[1],
) {
  const plan = planVerifiedProviderFact(current, fact);
  if (plan.kind !== 'apply') throw new Error(`expected apply: ${plan.kind}`);
  return plan.record;
}

describe('Billing subscription aggregate', () => {
  it('starts as checkout-pending without granting paid or trial facts', () => {
    const record = checkoutRecord();
    expect(record).toMatchObject({
      accountId: billingContext().accountId,
      vaultId: billingContext().vaultId,
      lifecycle: { kind: 'checkout-pending' },
      paymentMethodReady: false,
      version: 1,
    });
  });

  it('accepts a verified 14-day trial with a registered payment method', () => {
    const plan = planVerifiedProviderFact(checkoutRecord(), trialStartedFact());
    expect(plan).toMatchObject({
      kind: 'apply',
      record: {
        lifecycle: { kind: 'trialing' },
        paymentMethodReady: true,
        version: 2,
      },
    });
    expect(
      planVerifiedProviderFact(checkoutRecord(), {
        ...trialStartedFact(),
        trialEndsAt: trialStartedFact().trialEndsAt - 1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-transition' });
  });

  it('keeps payment failure locked through card update and resumes only for a newer invoice.paid fact', () => {
    const trial = apply(checkoutRecord(), trialStartedFact());
    const failed = apply(trial, paymentFailedFact(5_000));
    expect(failed.lifecycle).toMatchObject({
      kind: 'delinquent',
      reason: 'payment-failed',
    });

    const cardUpdated = apply(failed, paymentMethodUpdatedFact(6_000));
    expect(cardUpdated.lifecycle.kind).toBe('delinquent');

    const oldPaid = apply(cardUpdated, invoicePaidFact(4_000));
    expect(oldPaid.lifecycle.kind).toBe('delinquent');

    const currentPaid = apply(oldPaid, invoicePaidFact(7_000));
    expect(currentPaid.lifecycle).toMatchObject({
      kind: 'active',
      paidThrough: invoicePaidFact(7_000).paidPeriodEndsAt,
    });
  });

  it('makes same-time delinquency dominate paid evidence regardless of delivery order', () => {
    const trial = apply(checkoutRecord(), trialStartedFact());
    const paidFirst = apply(trial, invoicePaidFact(5_000));
    const failureSecond = apply(paidFirst, paymentFailedFact(5_000));
    expect(failureSecond.lifecycle.kind).toBe('delinquent');

    const failedFirst = apply(trial, paymentActionRequiredFact(5_000));
    const paidSecond = apply(failedFirst, invoicePaidFact(5_000));
    expect(paidSecond.lifecycle.kind).toBe('delinquent');
  });

  it('ignores an older failure after a newer paid invoice', () => {
    const active = apply(
      apply(checkoutRecord(), trialStartedFact()),
      invoicePaidFact(7_000),
    );
    expect(planVerifiedProviderFact(active, paymentFailedFact(6_000))).toEqual({
      kind: 'ignore',
      reason: 'stale',
      record: active,
    });
  });

  it('reconciles with paid invoice evidence and rejects stale snapshots', () => {
    const current = apply(checkoutRecord(), paymentFailedFact(5_000));
    const snapshot = reconciliationSnapshot(8_000);
    const reconciled = planReconciliationSnapshot(current, snapshot);
    expect(reconciled).toMatchObject({
      kind: 'apply',
      record: { lifecycle: { kind: 'active' }, lastReconciledAt: 8_000 },
    });
    if (reconciled.kind !== 'apply') {
      throw new Error('expected reconciliation');
    }
    expect(
      planReconciliationSnapshot(
        reconciled.record,
        reconciliationSnapshot(7_000),
      ),
    ).toMatchObject({ kind: 'ignore', reason: 'stale' });
  });

  it('keeps cancellation terminal under later events and reconciliation', () => {
    const trial = apply(checkoutRecord(), trialStartedFact());
    const scheduled = apply(trial, cancellationScheduledFact());
    expect(scheduled.cancelAt).toBe(cancellationScheduledFact().cancelAt);
    const cancelled = apply(scheduled, subscriptionCancelledFact());
    expect(cancelled.lifecycle.kind).toBe('cancelled');
    expect(
      planVerifiedProviderFact(cancelled, invoicePaidFact(10_000)),
    ).toMatchObject({ kind: 'ignore', reason: 'terminal' });
    expect(
      planReconciliationSnapshot(cancelled, reconciliationSnapshot(11_000)),
    ).toMatchObject({ kind: 'ignore', reason: 'terminal' });
  });
});
