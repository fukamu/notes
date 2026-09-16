import {
  BoundaryDecodeError,
  literalDecoder,
  nullableDecoder,
  objectDecoder,
  safeIntegerDecoder,
  unionDecoder,
  type InferDecoder,
} from '../../lib/codec/core';
import {
  accountIdDecoder,
  sessionEpochDecoder,
  sessionIdDecoder,
  vaultIdDecoder,
} from '../../lib/domain/identity';
import {
  billingSubscriptionIdDecoder,
  billingVersionDecoder,
} from '../billing/public';
import type { EntitlementProjectionRecord, OfflineLeaseRecord } from './core';
import {
  entitlementProjectionVersionDecoder,
  offlineLeaseIdDecoder,
} from './public';

const timestampDecoder = safeIntegerDecoder({ minimum: 0 });
const stateKindDecoder = unionDecoder(
  literalDecoder('trial-active'),
  literalDecoder('paid-active'),
  literalDecoder('locked'),
);
const lockReasonDecoder = nullableDecoder(
  unionDecoder(
    literalDecoder('checkout-incomplete'),
    literalDecoder('payment-method-required'),
    literalDecoder('trial-expired'),
    literalDecoder('paid-period-expired'),
    literalDecoder('payment-failed'),
    literalDecoder('payment-action-required'),
    literalDecoder('cancelled'),
  ),
);
const sqliteBasisDecoder = unionDecoder(
  literalDecoder('trial'),
  literalDecoder('paid'),
);

export const entitlementProjectionRowDecoder = objectDecoder({
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  version: entitlementProjectionVersionDecoder,
  source_subscription_id: billingSubscriptionIdDecoder,
  source_billing_version: billingVersionDecoder,
  state: stateKindDecoder,
  valid_until: nullableDecoder(timestampDecoder),
  lock_reason: lockReasonDecoder,
  checked_at: timestampDecoder,
  created_at: timestampDecoder,
  updated_at: timestampDecoder,
});

export const offlineLeaseRowDecoder = objectDecoder({
  lease_id: offlineLeaseIdDecoder,
  account_id: accountIdDecoder,
  vault_id: vaultIdDecoder,
  session_id: sessionIdDecoder,
  session_epoch: sessionEpochDecoder,
  source_subscription_id: billingSubscriptionIdDecoder,
  source_billing_version: billingVersionDecoder,
  basis: sqliteBasisDecoder,
  issued_at: timestampDecoder,
  expires_at: timestampDecoder,
  revoked_at: nullableDecoder(timestampDecoder),
  created_at: timestampDecoder,
});

export type EntitlementProjectionRow = InferDecoder<
  typeof entitlementProjectionRowDecoder
>;
export type OfflineLeaseRow = InferDecoder<typeof offlineLeaseRowDecoder>;

export function mapEntitlementProjectionRow(
  row: EntitlementProjectionRow,
): EntitlementProjectionRecord {
  if (row.created_at > row.updated_at || row.checked_at !== row.updated_at) {
    invalidEntitlementRow('inconsistent projection timeline');
  }
  const state = (() => {
    switch (row.state) {
      case 'trial-active':
        if (
          row.valid_until === null ||
          row.valid_until <= row.checked_at ||
          row.lock_reason !== null
        ) {
          invalidEntitlementRow('invalid trial projection');
        }
        return { kind: 'trial-active', validUntil: row.valid_until } as const;
      case 'paid-active':
        if (
          row.valid_until === null ||
          row.valid_until <= row.checked_at ||
          row.lock_reason !== null
        ) {
          invalidEntitlementRow('invalid paid projection');
        }
        return { kind: 'paid-active', validUntil: row.valid_until } as const;
      case 'locked':
        if (row.valid_until !== null || row.lock_reason === null) {
          invalidEntitlementRow('invalid locked projection');
        }
        return { kind: 'locked', reason: row.lock_reason } as const;
    }
  })();
  return {
    accountId: row.account_id,
    vaultId: row.vault_id,
    version: row.version,
    sourceSubscriptionId: row.source_subscription_id,
    sourceBillingVersion: row.source_billing_version,
    state,
    checkedAt: row.checked_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function mapOfflineLeaseRow(row: OfflineLeaseRow): OfflineLeaseRecord {
  if (
    row.expires_at <= row.issued_at ||
    row.created_at !== row.issued_at ||
    (row.revoked_at !== null && row.revoked_at < row.issued_at)
  ) {
    invalidEntitlementRow('invalid offline lease timeline');
  }
  return {
    leaseId: row.lease_id,
    context: {
      accountId: row.account_id,
      vaultId: row.vault_id,
      sessionId: row.session_id,
      sessionEpoch: row.session_epoch,
    },
    sourceSubscriptionId: row.source_subscription_id,
    sourceBillingVersion: row.source_billing_version,
    basis: row.basis,
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function invalidEntitlementRow(reason: string): never {
  throw new BoundaryDecodeError('D1 Entitlement row', [{ path: [], reason }]);
}
