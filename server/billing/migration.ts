import type { MigrationDefinition } from '../migrations/core';

export const billingSubscriptionStatements = [
  `CREATE TABLE billing_subscriptions (
    subscription_id TEXT PRIMARY KEY NOT NULL,
    account_id TEXT NOT NULL,
    vault_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_customer_ref TEXT,
    provider_subscription_ref TEXT,
    version INTEGER NOT NULL,
    status TEXT NOT NULL,
    payment_method_ready INTEGER NOT NULL,
    payment_method_updated_at INTEGER,
    trial_started_at INTEGER,
    trial_ends_at INTEGER,
    trial_observed_at INTEGER,
    paid_period_started_at INTEGER,
    paid_period_ends_at INTEGER,
    last_paid_at INTEGER,
    last_paid_invoice_ref TEXT,
    delinquency_reason TEXT,
    delinquency_since INTEGER,
    delinquency_invoice_ref TEXT,
    cancel_at INTEGER,
    cancellation_updated_at INTEGER,
    cancelled_at INTEGER,
    last_reconciled_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    CONSTRAINT billing_subscriptions_owner_fk FOREIGN KEY (account_id, vault_id) REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
    CONSTRAINT billing_subscriptions_shape_check CHECK (
      version > 0
      AND status IN ('checkout-pending', 'trialing', 'active', 'delinquent', 'cancelled')
      AND payment_method_ready IN (0, 1)
      AND (provider_customer_ref IS NULL) = (provider_subscription_ref IS NULL)
      AND (last_paid_at IS NULL) = (last_paid_invoice_ref IS NULL)
      AND created_at >= 0 AND updated_at >= created_at
      AND (status <> 'trialing' OR (trial_started_at IS NOT NULL AND trial_ends_at > trial_started_at))
      AND (status <> 'active' OR (
        paid_period_started_at IS NOT NULL AND paid_period_ends_at > paid_period_started_at
        AND delinquency_reason IS NULL AND delinquency_since IS NULL AND delinquency_invoice_ref IS NULL
      ))
      AND (status <> 'delinquent' OR (
        delinquency_reason IN ('payment-failed', 'payment-action-required')
        AND delinquency_since IS NOT NULL AND delinquency_invoice_ref IS NOT NULL
      ))
      AND (status <> 'cancelled' OR cancelled_at IS NOT NULL)
    )
  )`,
  'CREATE UNIQUE INDEX idx_billing_subscriptions_owner ON billing_subscriptions(account_id, vault_id)',
  'CREATE UNIQUE INDEX idx_billing_subscriptions_customer ON billing_subscriptions(provider, provider_customer_ref)',
  'CREATE UNIQUE INDEX idx_billing_subscriptions_provider_subscription ON billing_subscriptions(provider, provider_subscription_ref)',
  'CREATE INDEX idx_billing_subscriptions_status ON billing_subscriptions(status, updated_at, subscription_id)',
  `CREATE TABLE billing_checkout_intents (
    checkout_intent_id TEXT PRIMARY KEY NOT NULL,
    subscription_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    provider_checkout_ref TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    opened_at INTEGER,
    CONSTRAINT billing_checkout_subscription_fk FOREIGN KEY (subscription_id) REFERENCES billing_subscriptions(subscription_id) ON DELETE CASCADE,
    CONSTRAINT billing_checkout_intents_shape_check CHECK (
      status IN ('created', 'opened') AND created_at >= 0
      AND (
        (status = 'created' AND provider_checkout_ref IS NULL AND opened_at IS NULL)
        OR (status = 'opened' AND provider_checkout_ref IS NOT NULL AND opened_at >= created_at)
      )
    )
  )`,
  'CREATE UNIQUE INDEX idx_billing_checkout_provider_ref ON billing_checkout_intents(provider, provider_checkout_ref)',
  'CREATE INDEX idx_billing_checkout_subscription ON billing_checkout_intents(subscription_id, created_at)',
  `CREATE TABLE billing_provider_event_receipts (
    provider TEXT NOT NULL,
    provider_event_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    fact_kind TEXT NOT NULL,
    outcome TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    applied_version INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (provider, provider_event_id),
    CONSTRAINT billing_provider_events_subscription_fk FOREIGN KEY (subscription_id) REFERENCES billing_subscriptions(subscription_id) ON DELETE CASCADE,
    CONSTRAINT billing_provider_events_shape_check CHECK (
      fact_kind IN (
        'trial-started', 'payment-method-updated', 'invoice-paid',
        'invoice-payment-failed', 'invoice-payment-action-required',
        'cancellation-scheduled', 'subscription-cancelled'
      )
      AND outcome IN ('applied', 'ignored')
      AND occurred_at >= 0 AND applied_version > 0 AND recorded_at >= 0
    )
  )`,
  'CREATE INDEX idx_billing_provider_events_subscription ON billing_provider_event_receipts(subscription_id, occurred_at, provider_event_id)',
  `CREATE TABLE billing_reconciliation_checkpoints (
    provider TEXT NOT NULL,
    snapshot_id TEXT NOT NULL,
    subscription_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL,
    applied_version INTEGER NOT NULL,
    recorded_at INTEGER NOT NULL,
    PRIMARY KEY (provider, snapshot_id),
    CONSTRAINT billing_reconcile_subscription_fk FOREIGN KEY (subscription_id) REFERENCES billing_subscriptions(subscription_id) ON DELETE CASCADE,
    CONSTRAINT billing_reconcile_shape_check CHECK (
      observed_at >= 0 AND applied_version > 0 AND recorded_at >= 0
    )
  )`,
  'CREATE INDEX idx_billing_reconcile_subscription ON billing_reconciliation_checkpoints(subscription_id, observed_at, snapshot_id)',
] as const;

export const billingSubscriptionMigration: MigrationDefinition = {
  id: '0006_billing_subscription',
  checksum:
    'sha256:3410011aab000866313424567699518aed6ff40dfab42d6452574c86acadbc93',
  statements: billingSubscriptionStatements,
};
