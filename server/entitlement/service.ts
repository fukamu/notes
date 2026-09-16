import type { VaultContext } from '../../lib/domain/identity';
import {
  authorizeEntitlementState,
  authorizeOfflineLease,
  evaluateSubscriptionFacts,
  planEntitlementProjection,
  planOfflineLease,
  type EntitlementProjectionRecord,
  type OfflineLeaseRecord,
} from './core';
import type { EntitlementDependencies } from './ports';
import {
  paidPersonalVaultLimits,
  type EntitlementCapability,
  type EntitlementDecision,
  type EntitlementDenialReason,
  type EntitlementLimitDecision,
  type EntitlementPort,
  type OfflineLeaseCommandResult,
  type OfflineLease,
  type OfflineLeasePolicy,
} from './public';

type ProjectionResult =
  | { readonly kind: 'ready'; readonly record: EntitlementProjectionRecord }
  | { readonly kind: 'denied'; readonly reason: EntitlementDenialReason };

export function createEntitlementPort(
  dependencies: EntitlementDependencies,
  offlineLeasePolicy: OfflineLeasePolicy,
): EntitlementPort {
  return {
    async authorizeCapability(
      context,
      capability,
      checkedAt,
    ): Promise<EntitlementDecision> {
      const owner = await verifyOwner(dependencies, context);
      if (owner !== 'owned') return denied(capability, owner);
      const projection = await refreshProjection(
        dependencies,
        context,
        checkedAt,
      );
      if (projection.kind === 'denied') {
        return isRecoveryCapability(capability) &&
          projection.reason !== 'invalid-input'
          ? recoveryAllowed(capability)
          : denied(capability, projection.reason);
      }
      return authorizeEntitlementState(
        projection.record.state,
        capability,
        checkedAt,
      );
    },

    async readLimits(context, checkedAt): Promise<EntitlementLimitDecision> {
      const owner = await verifyOwner(dependencies, context);
      if (owner !== 'owned') return { kind: 'denied', reason: owner };
      const projection = await refreshProjection(
        dependencies,
        context,
        checkedAt,
      );
      if (projection.kind === 'denied') return projection;
      const decision = authorizeEntitlementState(
        projection.record.state,
        'notes-read',
        checkedAt,
      );
      return decision.kind === 'allowed' && decision.validUntil !== null
        ? {
            kind: 'available',
            limits: paidPersonalVaultLimits,
            validUntil: decision.validUntil,
          }
        : {
            kind: 'denied',
            reason:
              decision.kind === 'denied'
                ? decision.reason
                : 'entitlement-unavailable',
          };
    },

    async issueOfflineLease(
      context,
      input,
    ): Promise<OfflineLeaseCommandResult> {
      const owner = await verifyOwner(dependencies, context);
      if (owner !== 'owned') return { kind: 'denied', reason: owner };
      if (offlineLeasePolicy.kind === 'undecided') {
        return { kind: 'denied', reason: 'lease-policy-undecided' };
      }
      const projection = await refreshProjection(
        dependencies,
        context,
        input.issuedAt,
      );
      if (projection.kind === 'denied') return projection;
      const plan = planOfflineLease(
        context,
        projection.record,
        offlineLeasePolicy,
        input,
      );
      if (plan.kind === 'denied') return plan;
      try {
        const created = await dependencies.repository.createOfflineLease({
          expectedProjectionVersion: projection.record.version,
          lease: plan.lease,
        });
        switch (created.kind) {
          case 'issued':
            return { kind: 'issued', lease: toOfflineLease(plan.lease) };
          case 'replayed':
            return { kind: 'replayed', lease: toOfflineLease(created.lease) };
          case 'identifier-conflict':
            return { kind: 'denied', reason: 'identifier-conflict' };
          case 'projection-conflict':
            return { kind: 'denied', reason: 'projection-conflict' };
        }
      } catch {
        return { kind: 'denied', reason: 'entitlement-unavailable' };
      }
    },

    async authorizeOfflineCapability(
      context,
      capability,
      leaseId,
      checkedAt,
    ): Promise<EntitlementDecision> {
      const owner = await verifyOwner(dependencies, context);
      if (owner !== 'owned') return denied(capability, owner);
      try {
        const lease = await dependencies.repository.findOfflineLease(
          context,
          leaseId,
        );
        return lease === undefined
          ? denied(capability, 'lease-not-found')
          : authorizeOfflineLease(lease, context, capability, checkedAt);
      } catch {
        return denied(capability, 'entitlement-unavailable');
      }
    },
  };
}

async function refreshProjection(
  dependencies: EntitlementDependencies,
  context: VaultContext,
  checkedAt: number,
): Promise<ProjectionResult> {
  if (!Number.isSafeInteger(checkedAt) || checkedAt < 0) {
    return { kind: 'denied', reason: 'invalid-input' };
  }
  let facts;
  try {
    facts = await dependencies.billing.readSubscription(context);
  } catch {
    return { kind: 'denied', reason: 'billing-unavailable' };
  }
  if (facts === undefined) {
    return { kind: 'denied', reason: 'subscription-required' };
  }
  const evaluation = evaluateSubscriptionFacts(facts, checkedAt);
  if (evaluation.kind === 'invalid') {
    return { kind: 'denied', reason: 'billing-unavailable' };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let current;
    try {
      current = await dependencies.repository.findProjection(context);
    } catch {
      return { kind: 'denied', reason: 'entitlement-unavailable' };
    }
    const plan = planEntitlementProjection(
      context,
      facts,
      evaluation.state,
      checkedAt,
      current,
    );
    switch (plan.kind) {
      case 'invalid':
        return { kind: 'denied', reason: 'billing-unavailable' };
      case 'stale':
        return { kind: 'denied', reason: 'projection-conflict' };
      case 'current':
        return { kind: 'ready', record: plan.record };
      case 'commit':
        try {
          const committed = await dependencies.repository.commitProjection({
            expectedVersion: current?.version,
            record: plan.record,
            revokeActiveLeasesAt:
              plan.record.state.kind === 'locked' ? checkedAt : null,
          });
          if (committed.kind === 'applied') {
            return { kind: 'ready', record: plan.record };
          }
        } catch {
          return { kind: 'denied', reason: 'entitlement-unavailable' };
        }
        break;
    }
  }
  return { kind: 'denied', reason: 'projection-conflict' };
}

async function verifyOwner(
  dependencies: EntitlementDependencies,
  context: VaultContext,
): Promise<'owned' | 'owner-mismatch' | 'entitlement-unavailable'> {
  try {
    return (await dependencies.ownership.owns(context))
      ? 'owned'
      : 'owner-mismatch';
  } catch {
    return 'entitlement-unavailable';
  }
}

function isRecoveryCapability(capability: EntitlementCapability): boolean {
  return (
    capability === 'billing-recovery' ||
    capability === 'subscription-cancel' ||
    capability === 'account-delete' ||
    capability === 'support'
  );
}

function recoveryAllowed(
  capability: EntitlementCapability,
): EntitlementDecision {
  return {
    kind: 'allowed',
    capability,
    basis: 'recovery',
    validUntil: null,
  };
}

function toOfflineLease(record: OfflineLeaseRecord): OfflineLease {
  return {
    leaseId: record.leaseId,
    context: record.context,
    basis: record.basis,
    issuedAt: record.issuedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
  };
}

function denied(
  capability: EntitlementCapability,
  reason: EntitlementDenialReason,
): EntitlementDecision {
  return { kind: 'denied', capability, reason };
}
