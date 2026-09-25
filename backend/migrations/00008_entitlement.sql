-- +goose Up
CREATE TABLE entitlement_projections (
  account_id text NOT NULL,
  vault_id text NOT NULL,
  version bigint NOT NULL,
  source_subscription_id text NOT NULL,
  source_billing_version bigint NOT NULL,
  state text NOT NULL,
  valid_until bigint,
  lock_reason text,
  checked_at bigint NOT NULL,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  PRIMARY KEY (account_id, vault_id),
  CONSTRAINT entitlement_projection_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT entitlement_projection_subscription_fk
    FOREIGN KEY (source_subscription_id)
    REFERENCES billing_subscriptions(subscription_id) ON DELETE CASCADE,
  CONSTRAINT entitlement_projection_shape_check CHECK (
    version BETWEEN 1 AND 2147483647
    AND source_billing_version BETWEEN 1 AND 2147483647
    AND state IN ('trial-active', 'paid-active', 'locked')
    AND checked_at BETWEEN 0 AND 9007199254740991
    AND created_at BETWEEN 0 AND 9007199254740991
    AND updated_at = checked_at AND updated_at >= created_at
    AND (
      (state IN ('trial-active', 'paid-active')
        AND valid_until > checked_at AND valid_until <= 9007199254740991
        AND lock_reason IS NULL)
      OR
      (state = 'locked' AND valid_until IS NULL AND lock_reason IN (
        'checkout-incomplete', 'payment-method-required',
        'trial-expired', 'paid-period-expired', 'payment-failed',
        'payment-action-required', 'cancelled'
      ))
    )
  )
);
CREATE INDEX idx_entitlement_projection_state
  ON entitlement_projections(state, checked_at, vault_id);

CREATE TABLE entitlement_offline_leases (
  lease_id text PRIMARY KEY,
  account_id text NOT NULL,
  vault_id text NOT NULL,
  session_id text NOT NULL,
  session_epoch bigint NOT NULL,
  source_subscription_id text NOT NULL,
  source_billing_version bigint NOT NULL,
  basis text NOT NULL,
  issued_at bigint NOT NULL,
  expires_at bigint NOT NULL,
  revoked_at bigint,
  created_at bigint NOT NULL,
  CONSTRAINT entitlement_lease_projection_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES entitlement_projections(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT entitlement_offline_lease_shape_check CHECK (
    lease_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND session_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND session_epoch BETWEEN 1 AND 2147483647
    AND source_billing_version BETWEEN 1 AND 2147483647
    AND basis IN ('trial', 'paid')
    AND issued_at BETWEEN 0 AND 9007199254740991
    AND expires_at > issued_at AND expires_at <= 9007199254740991
    AND created_at = issued_at
    AND (revoked_at IS NULL OR revoked_at BETWEEN issued_at AND 9007199254740991)
  )
);
CREATE INDEX idx_entitlement_leases_owner
  ON entitlement_offline_leases(account_id, vault_id, expires_at, lease_id);
CREATE INDEX idx_entitlement_leases_expiry
  ON entitlement_offline_leases(expires_at, revoked_at, lease_id);

-- +goose Down
DROP TABLE entitlement_offline_leases;
DROP TABLE entitlement_projections;
