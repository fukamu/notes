import type { EntitlementDecision } from '../entitlement/public';
import type { SyncV2ApplicationResult } from './public';

export type SyncV2HttpAccessPlan =
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'reject';
      readonly status: 402 | 403 | 503;
      readonly error: 'online-access-locked' | 'forbidden' | 'unavailable';
    };

export function planSyncV2EntitlementAccess(
  decision: EntitlementDecision,
): SyncV2HttpAccessPlan {
  if (decision.kind === 'allowed') {
    return decision.capability === 'notes-sync'
      ? { kind: 'continue' }
      : { kind: 'reject', status: 403, error: 'forbidden' };
  }
  switch (decision.reason) {
    case 'owner-mismatch':
      return { kind: 'reject', status: 403, error: 'forbidden' };
    case 'billing-unavailable':
    case 'entitlement-unavailable':
    case 'invalid-input':
    case 'projection-conflict':
      return { kind: 'reject', status: 503, error: 'unavailable' };
    case 'checkout-incomplete':
    case 'payment-method-required':
    case 'trial-expired':
    case 'paid-period-expired':
    case 'payment-failed':
    case 'payment-action-required':
    case 'cancelled':
    case 'subscription-required':
    case 'lease-policy-undecided':
    case 'lease-not-found':
    case 'lease-expired':
    case 'lease-revoked':
    case 'lease-scope-mismatch':
    case 'online-required':
    case 'identifier-conflict':
      return {
        kind: 'reject',
        status: 402,
        error: 'online-access-locked',
      };
  }
}

export function planSyncV2ApplicationHttpResult(
  result: Exclude<SyncV2ApplicationResult, { readonly kind: 'synchronized' }>,
): { readonly status: 400 | 409 | 503; readonly error: string } {
  switch (result.reason) {
    case 'invalid-cursor':
      return { status: 400, error: 'invalid-request' };
    case 'idempotency-key-reuse':
    case 'mutation-conflict':
      return { status: 409, error: 'sync-conflict' };
    case 'scope-unavailable':
      return { status: 503, error: 'unavailable' };
  }
}
