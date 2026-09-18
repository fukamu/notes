import { decodeOrThrow } from '@/lib/codec/core';
import { parseSessionEpoch, parseSessionId } from '@/lib/domain/identity';
import { BILLING_TRIAL_DURATION_MS } from '@/server/billing/core';
import {
  billingVersionDecoder,
  type BillingLifecycle,
  type BillingSubscriptionFacts,
} from '@/server/billing/public';
import {
  parseOfflineLeaseDuration,
  parseOfflineLeaseId,
  type OfflineLeasePolicy,
} from '@/server/entitlement/public';
import { billingContext, billingIds } from '@/tests/fixtures/billing';
import type { VaultContext } from '@/lib/domain/identity';

export const entitlementIds = {
  leaseA: parseOfflineLeaseId('01991f20-61d2-7000-8000-000000001801'),
  leaseB: parseOfflineLeaseId('01991f20-61d2-7000-8000-000000001802'),
  sessionB: parseSessionId('01991f20-61d2-7000-8000-000000001402'),
  epochTwo: parseSessionEpoch(2),
} as const;

export const undecidedOfflineLeasePolicy: OfflineLeasePolicy = {
  kind: 'undecided',
};

export function configuredOfflineLeasePolicy(
  duration = 60_000,
): OfflineLeasePolicy {
  return { kind: 'configured', duration: parseOfflineLeaseDuration(duration) };
}

export function alternateSessionContext(): VaultContext {
  return {
    ...billingContext(),
    sessionId: entitlementIds.sessionB,
    sessionEpoch: entitlementIds.epochTwo,
  };
}

export function subscriptionFacts(
  lifecycle: BillingLifecycle = {
    kind: 'trialing',
    trialStartedAt: 2_000,
    trialEndsAt: 2_000 + BILLING_TRIAL_DURATION_MS,
  },
  input: {
    readonly version?: number;
    readonly paymentMethodReady?: boolean;
    readonly cancelAt?: number | null;
    readonly updatedAt?: number;
  } = {},
): BillingSubscriptionFacts {
  const context = billingContext();
  return {
    subscriptionId: billingIds.subscriptionA,
    accountId: context.accountId,
    vaultId: context.vaultId,
    version: decodeOrThrow(
      billingVersionDecoder,
      input.version ?? 2,
      'BillingVersion fixture',
    ),
    lifecycle,
    paymentMethodReady: input.paymentMethodReady ?? true,
    cancelAt: input.cancelAt ?? null,
    updatedAt: input.updatedAt ?? 2_000,
  };
}
