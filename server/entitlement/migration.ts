import type { MigrationDefinition } from '../migrations/core';

export const entitlementStatements = [
  `CREATE TABLE entitlement_projections (
    account_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    source_subscription_id TEXT NOT NULL,
    source_billing_version INTEGER NOT NULL,
    state TEXT NOT NULL,
    valid_until INTEGER,
    lock_reason TEXT,
    checked_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (account_id, vault_id),
    CONSTRAINT entitlement_projection_owner_fk FOREIGN KEY (account_id, vault_id) REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
    CONSTRAINT entitlement_projection_shape_check CHECK (
      version > 0 AND source_billing_version > 0
      AND state IN ('trial-active', 'paid-active', 'locked')
      AND checked_at >= 0 AND created_at >= 0
      AND updated_at = checked_at AND updated_at >= created_at
      AND (
        (state IN ('trial-active', 'paid-active') AND valid_until > checked_at AND lock_reason IS NULL)
        OR (state = 'locked' AND valid_until IS NULL AND lock_reason IN (
          'checkout-incomplete', 'payment-method-required',
          'trial-expired', 'paid-period-expired', 'payment-failed',
          'payment-action-required', 'cancelled'
        ))
      )
    )
  )`,
  'CREATE INDEX idx_entitlement_projection_state ON entitlement_projections(state, checked_at, vault_id)',
  `CREATE TABLE entitlement_offline_leases (
    lease_id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    session_epoch INTEGER NOT NULL,
    source_subscription_id TEXT NOT NULL,
    source_billing_version INTEGER NOT NULL,
    basis TEXT NOT NULL,
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    created_at INTEGER NOT NULL,
    CONSTRAINT entitlement_lease_projection_fk FOREIGN KEY (account_id, vault_id) REFERENCES entitlement_projections(account_id, vault_id) ON DELETE CASCADE,
    CONSTRAINT entitlement_offline_lease_shape_check CHECK (
      session_epoch > 0 AND source_billing_version > 0
      AND basis IN ('trial', 'paid')
      AND issued_at >= 0 AND expires_at > issued_at
      AND created_at = issued_at
      AND (revoked_at IS NULL OR revoked_at >= issued_at)
    )
  )`,
  'CREATE INDEX idx_entitlement_leases_owner ON entitlement_offline_leases(account_id, vault_id, expires_at, lease_id)',
  'CREATE INDEX idx_entitlement_leases_expiry ON entitlement_offline_leases(expires_at, revoked_at, lease_id)',
] as const;

export const entitlementMigration: MigrationDefinition = {
  id: '0007_entitlement',
  checksum:
    'sha256:07bfd7e0f62330facfa35abbe572509be3fe2252300be4a4594fb2f063baac45',
  statements: entitlementStatements,
};
