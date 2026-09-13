import type {
  AccountId,
  VaultContext,
  VaultId,
} from '../../lib/domain/identity';
import type {
  BillingSubscriptionFacts,
  BillingSubscriptionId,
  BillingVersion,
} from '../billing/public';
import type {
  EntitlementCapability,
  EntitlementDecision,
  EntitlementLockReason,
  EntitlementProjectionVersion,
  EntitlementState,
  OfflineLease,
  OfflineLeaseId,
  OfflineLeasePolicy,
} from './public';

export type OfflineLeaseRecord = OfflineLease & {
  readonly sourceSubscriptionId: BillingSubscriptionId;
  readonly sourceBillingVersion: BillingVersion;
};

export type EntitlementProjectionRecord = {
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly version: EntitlementProjectionVersion;
  readonly sourceSubscriptionId: BillingSubscriptionId;
  readonly sourceBillingVersion: BillingVersion;
  readonly state: EntitlementState;
  readonly checkedAt: number;
  readonly createdAt: number;
  readonly updatedAt: number;
};

export type SubscriptionEvaluation =
  | { readonly kind: 'evaluated'; readonly state: EntitlementState }
  | { readonly kind: 'invalid' };

export type ProjectionPlan =
  | { readonly kind: 'commit'; readonly record: EntitlementProjectionRecord }
  | {
      readonly kind: 'current';
      readonly record: EntitlementProjectionRecord;
    }
  | { readonly kind: 'stale' }
  | { readonly kind: 'invalid' };

export type OfflineLeasePlan =
  | { readonly kind: 'issue'; readonly lease: OfflineLeaseRecord }
  | {
      readonly kind: 'denied';
      readonly reason:
        | EntitlementLockReason
        | 'lease-policy-undecided'
        | 'invalid-input';
    };

const contentCapabilities: readonly EntitlementCapability[] = [
  'notes-read',
  'notes-write',
  'notes-sync',
];

export function evaluateSubscriptionFacts(
  facts: BillingSubscriptionFacts,
  checkedAt: number,
): SubscriptionEvaluation {
  if (!validTimestamp(checkedAt) || !validFactsTimeline(facts)) {
    return { kind: 'invalid' };
  }
  const scheduledEnd = facts.cancelAt;
  switch (facts.lifecycle.kind) {
    case 'checkout-pending':
      return {
        kind: 'evaluated',
        state: {
          kind: 'locked',
          reason: facts.paymentMethodReady
            ? 'checkout-incomplete'
            : 'payment-method-required',
        },
      };
    case 'trialing': {
      if (!facts.paymentMethodReady) {
        return locked('payment-method-required');
      }
      const validUntil = effectiveEnd(
        facts.lifecycle.trialEndsAt,
        scheduledEnd,
      );
      if (checkedAt < validUntil) {
        return {
          kind: 'evaluated',
          state: { kind: 'trial-active', validUntil },
        };
      }
      return locked(
        scheduledEnd !== null && scheduledEnd <= checkedAt
          ? 'cancelled'
          : 'trial-expired',
      );
    }
    case 'active': {
      if (!facts.paymentMethodReady) {
        return locked('payment-method-required');
      }
      const validUntil = effectiveEnd(
        facts.lifecycle.paidThrough,
        scheduledEnd,
      );
      if (checkedAt < validUntil) {
        return {
          kind: 'evaluated',
          state: { kind: 'paid-active', validUntil },
        };
      }
      return locked(
        scheduledEnd !== null && scheduledEnd <= checkedAt
          ? 'cancelled'
          : 'paid-period-expired',
      );
    }
    case 'delinquent':
      return locked(facts.lifecycle.reason);
    case 'cancelled':
      return locked('cancelled');
  }
}

export function authorizeEntitlementState(
  state: EntitlementState,
  capability: EntitlementCapability,
  checkedAt: number,
): EntitlementDecision {
  if (!validTimestamp(checkedAt)) {
    return { kind: 'denied', capability, reason: 'invalid-input' };
  }
  if (!contentCapabilities.includes(capability)) {
    return {
      kind: 'allowed',
      capability,
      basis: 'recovery',
      validUntil: null,
    };
  }
  switch (state.kind) {
    case 'trial-active':
      return checkedAt < state.validUntil
        ? {
            kind: 'allowed',
            capability,
            basis: 'trial',
            validUntil: state.validUntil,
          }
        : { kind: 'denied', capability, reason: 'trial-expired' };
    case 'paid-active':
      return checkedAt < state.validUntil
        ? {
            kind: 'allowed',
            capability,
            basis: 'paid',
            validUntil: state.validUntil,
          }
        : { kind: 'denied', capability, reason: 'paid-period-expired' };
    case 'locked':
      return { kind: 'denied', capability, reason: state.reason };
  }
}

export function planEntitlementProjection(
  context: VaultContext,
  facts: BillingSubscriptionFacts,
  state: EntitlementState,
  checkedAt: number,
  current: EntitlementProjectionRecord | undefined,
): ProjectionPlan {
  if (
    !validTimestamp(checkedAt) ||
    facts.accountId !== context.accountId ||
    facts.vaultId !== context.vaultId
  ) {
    return { kind: 'invalid' };
  }
  if (
    current !== undefined &&
    (current.accountId !== context.accountId ||
      current.vaultId !== context.vaultId ||
      current.sourceSubscriptionId !== facts.subscriptionId)
  ) {
    return { kind: 'invalid' };
  }
  if (
    current !== undefined &&
    (current.sourceBillingVersion > facts.version ||
      current.checkedAt > checkedAt)
  ) {
    return { kind: 'stale' };
  }
  if (
    current !== undefined &&
    current.sourceBillingVersion === facts.version &&
    current.checkedAt === checkedAt &&
    sameState(current.state, state)
  ) {
    return { kind: 'current', record: current };
  }
  return {
    kind: 'commit',
    record: {
      accountId: context.accountId,
      vaultId: context.vaultId,
      version: nextProjectionVersion(current?.version),
      sourceSubscriptionId: facts.subscriptionId,
      sourceBillingVersion: facts.version,
      state,
      checkedAt,
      createdAt: current?.createdAt ?? checkedAt,
      updatedAt: checkedAt,
    },
  };
}

export function planOfflineLease(
  context: VaultContext,
  projection: EntitlementProjectionRecord,
  policy: OfflineLeasePolicy,
  input: { readonly leaseId: OfflineLeaseId; readonly issuedAt: number },
): OfflineLeasePlan {
  if (
    !validTimestamp(input.issuedAt) ||
    projection.accountId !== context.accountId ||
    projection.vaultId !== context.vaultId
  ) {
    return { kind: 'denied', reason: 'invalid-input' };
  }
  if (policy.kind === 'undecided') {
    return { kind: 'denied', reason: 'lease-policy-undecided' };
  }
  if (projection.state.kind === 'locked') {
    return { kind: 'denied', reason: projection.state.reason };
  }
  if (input.issuedAt >= projection.state.validUntil) {
    return {
      kind: 'denied',
      reason:
        projection.state.kind === 'trial-active'
          ? 'trial-expired'
          : 'paid-period-expired',
    };
  }
  const policyEnd = input.issuedAt + policy.duration;
  if (!Number.isSafeInteger(policyEnd)) {
    return { kind: 'denied', reason: 'invalid-input' };
  }
  const expiresAt = Math.min(policyEnd, projection.state.validUntil);
  return {
    kind: 'issue',
    lease: {
      leaseId: input.leaseId,
      context,
      sourceSubscriptionId: projection.sourceSubscriptionId,
      sourceBillingVersion: projection.sourceBillingVersion,
      basis: projection.state.kind === 'trial-active' ? 'trial' : 'paid',
      issuedAt: input.issuedAt,
      expiresAt,
      revokedAt: null,
    },
  };
}

export function authorizeOfflineLease(
  lease: OfflineLease,
  context: VaultContext,
  capability: EntitlementCapability,
  checkedAt: number,
): EntitlementDecision {
  if (!validTimestamp(checkedAt)) {
    return { kind: 'denied', capability, reason: 'invalid-input' };
  }
  if (!sameContext(lease.context, context)) {
    return { kind: 'denied', capability, reason: 'lease-scope-mismatch' };
  }
  if (capability !== 'notes-read' && capability !== 'notes-write') {
    return { kind: 'denied', capability, reason: 'online-required' };
  }
  if (lease.revokedAt !== null && lease.revokedAt <= checkedAt) {
    return { kind: 'denied', capability, reason: 'lease-revoked' };
  }
  if (checkedAt >= lease.expiresAt) {
    return { kind: 'denied', capability, reason: 'lease-expired' };
  }
  return {
    kind: 'allowed',
    capability,
    basis: lease.basis,
    validUntil: lease.expiresAt,
  };
}

function locked(reason: EntitlementLockReason): SubscriptionEvaluation {
  return { kind: 'evaluated', state: { kind: 'locked', reason } };
}

function effectiveEnd(periodEnd: number, cancelAt: number | null): number {
  return cancelAt === null ? periodEnd : Math.min(periodEnd, cancelAt);
}

function validFactsTimeline(facts: BillingSubscriptionFacts): boolean {
  if (
    !validTimestamp(facts.updatedAt) ||
    (facts.cancelAt !== null && !validTimestamp(facts.cancelAt))
  ) {
    return false;
  }
  switch (facts.lifecycle.kind) {
    case 'checkout-pending':
      return true;
    case 'trialing':
      return (
        validTimestamp(facts.lifecycle.trialStartedAt) &&
        validTimestamp(facts.lifecycle.trialEndsAt) &&
        facts.lifecycle.trialEndsAt > facts.lifecycle.trialStartedAt
      );
    case 'active':
      return (
        validTimestamp(facts.lifecycle.paidPeriodStartedAt) &&
        validTimestamp(facts.lifecycle.paidThrough) &&
        facts.lifecycle.paidThrough > facts.lifecycle.paidPeriodStartedAt
      );
    case 'delinquent':
      return validTimestamp(facts.lifecycle.since);
    case 'cancelled':
      return validTimestamp(facts.lifecycle.cancelledAt);
  }
}

function sameState(left: EntitlementState, right: EntitlementState): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'trial-active':
      return (
        right.kind === 'trial-active' && left.validUntil === right.validUntil
      );
    case 'paid-active':
      return (
        right.kind === 'paid-active' && left.validUntil === right.validUntil
      );
    case 'locked':
      return right.kind === 'locked' && left.reason === right.reason;
  }
}

function sameContext(left: VaultContext, right: VaultContext): boolean {
  return (
    left.accountId === right.accountId &&
    left.vaultId === right.vaultId &&
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch
  );
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function nextProjectionVersion(
  current: EntitlementProjectionVersion | undefined,
): EntitlementProjectionVersion {
  return (
    current === undefined ? 1 : current + 1
  ) as EntitlementProjectionVersion;
}
