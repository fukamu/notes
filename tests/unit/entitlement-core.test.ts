import { describe, expect, it } from 'vitest';
import { BILLING_TRIAL_DURATION_MS } from '@/server/billing/core';
import {
  authorizeEntitlementState,
  authorizeOfflineLease,
  evaluateSubscriptionFacts,
  planEntitlementProjection,
  planOfflineLease,
} from '@/server/entitlement/core';
import {
  paidPersonalVaultLimits,
  type EntitlementCapability,
} from '@/server/entitlement/public';
import { billingContext, billingIds } from '@/tests/fixtures/billing';
import {
  alternateSessionContext,
  configuredOfflineLeasePolicy,
  entitlementIds,
  subscriptionFacts,
  undecidedOfflineLeasePolicy,
} from '@/tests/fixtures/entitlement';

describe('Entitlement pure policy', () => {
  it('fixes the 14-day trial boundary without granting day 15 from the clock alone', () => {
    const facts = subscriptionFacts();
    const trialEnd = 2_000 + BILLING_TRIAL_DURATION_MS;
    expect(evaluateSubscriptionFacts(facts, trialEnd - 1)).toEqual({
      kind: 'evaluated',
      state: { kind: 'trial-active', validUntil: trialEnd },
    });
    expect(evaluateSubscriptionFacts(facts, trialEnd)).toEqual({
      kind: 'evaluated',
      state: { kind: 'locked', reason: 'trial-expired' },
    });
  });

  it('requires payment readiness and a verified paid period', () => {
    expect(
      evaluateSubscriptionFacts(
        subscriptionFacts(undefined, { paymentMethodReady: false }),
        3_000,
      ),
    ).toMatchObject({
      state: { kind: 'locked', reason: 'payment-method-required' },
    });
    expect(
      evaluateSubscriptionFacts(
        subscriptionFacts({
          kind: 'active',
          paidPeriodStartedAt: 10_000,
          paidThrough: 20_000,
        }),
        19_999,
      ),
    ).toMatchObject({ state: { kind: 'paid-active', validUntil: 20_000 } });
    expect(
      evaluateSubscriptionFacts(
        subscriptionFacts({
          kind: 'active',
          paidPeriodStartedAt: 10_000,
          paidThrough: 20_000,
        }),
        20_000,
      ),
    ).toMatchObject({
      state: { kind: 'locked', reason: 'paid-period-expired' },
    });
  });

  it.each([
    ['payment-failed', 'payment-failed'],
    ['payment-action-required', 'payment-action-required'],
  ] as const)('locks online notes for %s', (billingReason, reason) => {
    expect(
      evaluateSubscriptionFacts(
        subscriptionFacts({
          kind: 'delinquent',
          reason: billingReason,
          since: 5_000,
          invoiceReference: billingIds.invoice1,
        }),
        5_000,
      ),
    ).toMatchObject({ state: { kind: 'locked', reason } });
  });

  it('caps access at a scheduled cancellation and keeps recovery capabilities open', () => {
    const evaluation = evaluateSubscriptionFacts(
      subscriptionFacts(undefined, { cancelAt: 4_000 }),
      4_000,
    );
    expect(evaluation).toMatchObject({
      state: { kind: 'locked', reason: 'cancelled' },
    });
    if (evaluation.kind !== 'evaluated') throw new Error('invalid fixture');
    expect(
      authorizeEntitlementState(evaluation.state, 'notes-sync', 4_000),
    ).toEqual({
      kind: 'denied',
      capability: 'notes-sync',
      reason: 'cancelled',
    });
    const recoveryCapabilities: readonly EntitlementCapability[] = [
      'billing-recovery',
      'subscription-cancel',
      'account-delete',
      'support',
    ];
    for (const capability of recoveryCapabilities) {
      expect(
        authorizeEntitlementState(evaluation.state, capability, 4_000),
      ).toMatchObject({ kind: 'allowed', basis: 'recovery' });
    }
  });

  it('plans monotonic projections and rejects stale or cross-owner facts', () => {
    const context = billingContext();
    const facts = subscriptionFacts();
    const evaluation = evaluateSubscriptionFacts(facts, 3_000);
    if (evaluation.kind !== 'evaluated') throw new Error('invalid fixture');
    const created = planEntitlementProjection(
      context,
      facts,
      evaluation.state,
      3_000,
      undefined,
    );
    expect(created).toMatchObject({ kind: 'commit', record: { version: 1 } });
    if (created.kind !== 'commit') throw new Error('invalid projection plan');
    expect(
      planEntitlementProjection(
        context,
        subscriptionFacts(undefined, { version: 1 }),
        evaluation.state,
        3_001,
        created.record,
      ),
    ).toEqual({ kind: 'stale' });
    expect(
      planEntitlementProjection(
        context,
        { ...facts, accountId: billingContext('b').accountId },
        evaluation.state,
        3_001,
        created.record,
      ),
    ).toEqual({ kind: 'invalid' });
  });

  it('keeps offline lease disabled while duration is undecided and scopes configured leases', () => {
    expect(paidPersonalVaultLimits.activeCards).toBe(10_000);
    const context = billingContext();
    const facts = subscriptionFacts();
    const evaluation = evaluateSubscriptionFacts(facts, 3_000);
    if (evaluation.kind !== 'evaluated') throw new Error('invalid fixture');
    const projected = planEntitlementProjection(
      context,
      facts,
      evaluation.state,
      3_000,
      undefined,
    );
    if (projected.kind !== 'commit') throw new Error('invalid projection plan');
    expect(
      planOfflineLease(context, projected.record, undecidedOfflineLeasePolicy, {
        leaseId: entitlementIds.leaseA,
        issuedAt: 3_000,
      }),
    ).toEqual({ kind: 'denied', reason: 'lease-policy-undecided' });
    const planned = planOfflineLease(
      context,
      projected.record,
      configuredOfflineLeasePolicy(60_000),
      { leaseId: entitlementIds.leaseA, issuedAt: 3_000 },
    );
    expect(planned).toMatchObject({
      kind: 'issue',
      lease: { expiresAt: 63_000, basis: 'trial' },
    });
    if (planned.kind !== 'issue') throw new Error('invalid lease plan');
    expect(
      authorizeOfflineLease(
        planned.lease,
        alternateSessionContext(),
        'notes-read',
        4_000,
      ),
    ).toMatchObject({ kind: 'denied', reason: 'lease-scope-mismatch' });
    expect(
      authorizeOfflineLease(planned.lease, context, 'notes-sync', 4_000),
    ).toMatchObject({ kind: 'denied', reason: 'online-required' });
    expect(
      authorizeOfflineLease(planned.lease, context, 'notes-read', 63_000),
    ).toMatchObject({ kind: 'denied', reason: 'lease-expired' });
  });
});
