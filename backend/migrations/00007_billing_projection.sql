-- +goose Up
CREATE TABLE billing_subscriptions (
  subscription_id text PRIMARY KEY,
  account_id text NOT NULL,
  vault_id text NOT NULL,
  provider text NOT NULL,
  provider_customer_ref text,
  provider_subscription_ref text,
  version bigint NOT NULL,
  status text NOT NULL,
  payment_method_ready boolean NOT NULL,
  payment_method_updated_at bigint,
  trial_started_at bigint,
  trial_ends_at bigint,
  trial_observed_at bigint,
  paid_period_started_at bigint,
  paid_period_ends_at bigint,
  last_paid_at bigint,
  last_paid_invoice_ref text,
  last_delinquency_at bigint,
  delinquency_reason text,
  delinquency_since bigint,
  delinquency_invoice_ref text,
  cancel_at bigint,
  cancellation_updated_at bigint,
  cancelled_at bigint,
  last_reconciled_at bigint,
  created_at bigint NOT NULL,
  updated_at bigint NOT NULL,
  CONSTRAINT billing_subscriptions_owner_fk
    FOREIGN KEY (account_id, vault_id)
    REFERENCES personal_vaults(account_id, vault_id) ON DELETE CASCADE,
  CONSTRAINT billing_subscriptions_shape_check CHECK (
    subscription_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND provider ~ '^[a-z][a-z0-9-]{0,31}$'
    AND version BETWEEN 1 AND 2147483647
    AND status IN ('checkout-pending', 'trialing', 'active', 'delinquent', 'cancelled')
    AND (provider_customer_ref IS NULL) = (provider_subscription_ref IS NULL)
    AND (last_paid_at IS NULL) = (last_paid_invoice_ref IS NULL)
    AND created_at BETWEEN 0 AND 9007199254740991
    AND updated_at BETWEEN created_at AND 9007199254740991
    AND (payment_method_updated_at IS NULL OR payment_method_updated_at BETWEEN 0 AND 9007199254740991)
    AND (trial_observed_at IS NULL OR trial_observed_at BETWEEN 0 AND 9007199254740991)
    AND (last_paid_at IS NULL OR last_paid_at BETWEEN 0 AND 9007199254740991)
    AND (last_delinquency_at IS NULL OR last_delinquency_at BETWEEN 0 AND 9007199254740991)
    AND (delinquency_since IS NULL OR delinquency_since BETWEEN 0 AND 9007199254740991)
    AND (cancel_at IS NULL OR cancel_at BETWEEN 0 AND 9007199254740991)
    AND (cancellation_updated_at IS NULL OR cancellation_updated_at BETWEEN 0 AND 9007199254740991)
    AND (last_reconciled_at IS NULL OR last_reconciled_at BETWEEN 0 AND 9007199254740991)
    AND (
      (status = 'checkout-pending'
        AND trial_started_at IS NULL AND trial_ends_at IS NULL
        AND trial_observed_at IS NULL AND last_paid_at IS NULL
        AND paid_period_started_at IS NULL AND paid_period_ends_at IS NULL
        AND delinquency_reason IS NULL AND delinquency_since IS NULL AND delinquency_invoice_ref IS NULL
        AND last_delinquency_at IS NULL AND cancelled_at IS NULL)
      OR
      (status = 'trialing'
        AND trial_started_at BETWEEN 0 AND 9007199254740991
        AND trial_ends_at > trial_started_at
        AND trial_observed_at IS NOT NULL AND payment_method_ready
        AND last_paid_at IS NULL
        AND paid_period_started_at IS NULL AND paid_period_ends_at IS NULL
        AND delinquency_reason IS NULL AND delinquency_since IS NULL AND delinquency_invoice_ref IS NULL
        AND last_delinquency_at IS NULL AND cancelled_at IS NULL)
      OR
      (status = 'active'
        AND trial_started_at IS NULL AND trial_ends_at IS NULL
        AND paid_period_started_at BETWEEN 0 AND 9007199254740991
        AND paid_period_ends_at > paid_period_started_at
        AND last_paid_at IS NOT NULL
        AND delinquency_reason IS NULL AND delinquency_since IS NULL AND delinquency_invoice_ref IS NULL
        AND last_delinquency_at IS NULL AND cancelled_at IS NULL)
      OR
      (status = 'delinquent'
        AND trial_started_at IS NULL AND trial_ends_at IS NULL
        AND paid_period_started_at IS NULL AND paid_period_ends_at IS NULL
        AND delinquency_reason IN ('payment-failed', 'payment-action-required')
        AND delinquency_since BETWEEN 0 AND 9007199254740991
        AND last_delinquency_at = delinquency_since
        AND char_length(delinquency_invoice_ref) BETWEEN 1 AND 255
        AND cancelled_at IS NULL)
      OR
      (status = 'cancelled'
        AND trial_started_at IS NULL AND trial_ends_at IS NULL
        AND paid_period_started_at IS NULL AND paid_period_ends_at IS NULL
        AND delinquency_reason IS NULL AND delinquency_since IS NULL AND delinquency_invoice_ref IS NULL
        AND cancelled_at BETWEEN 0 AND 9007199254740991)
    )
  )
);
CREATE UNIQUE INDEX idx_billing_subscriptions_owner
  ON billing_subscriptions(account_id, vault_id);
CREATE UNIQUE INDEX idx_billing_subscriptions_customer
  ON billing_subscriptions(provider, provider_customer_ref)
  WHERE provider_customer_ref IS NOT NULL;
CREATE UNIQUE INDEX idx_billing_subscriptions_provider_subscription
  ON billing_subscriptions(provider, provider_subscription_ref)
  WHERE provider_subscription_ref IS NOT NULL;
CREATE INDEX idx_billing_subscriptions_status
  ON billing_subscriptions(status, updated_at, subscription_id);

CREATE TABLE billing_checkout_intents (
  checkout_intent_id text PRIMARY KEY,
  subscription_id text NOT NULL,
  provider text NOT NULL,
  provider_checkout_ref text,
  status text NOT NULL,
  created_at bigint NOT NULL,
  opened_at bigint,
  CONSTRAINT billing_checkout_subscription_fk
    FOREIGN KEY (subscription_id) REFERENCES billing_subscriptions(subscription_id) ON DELETE CASCADE,
  CONSTRAINT billing_checkout_intents_shape_check CHECK (
    checkout_intent_id ~* '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    AND provider ~ '^[a-z][a-z0-9-]{0,31}$'
    AND created_at BETWEEN 0 AND 9007199254740991
    AND (
      (status = 'created' AND provider_checkout_ref IS NULL AND opened_at IS NULL)
      OR
      (status = 'opened' AND char_length(provider_checkout_ref) BETWEEN 1 AND 255 AND opened_at >= created_at)
    )
  )
);
CREATE UNIQUE INDEX idx_billing_checkout_provider_ref
  ON billing_checkout_intents(provider, provider_checkout_ref)
  WHERE provider_checkout_ref IS NOT NULL;
CREATE INDEX idx_billing_checkout_subscription
  ON billing_checkout_intents(subscription_id, created_at);

CREATE TABLE billing_provider_event_receipts (
  provider text NOT NULL,
  provider_event_id text NOT NULL,
  subscription_id text NOT NULL,
  fact_kind text NOT NULL,
  outcome text NOT NULL,
  occurred_at bigint NOT NULL,
  applied_version bigint NOT NULL,
  recorded_at bigint NOT NULL,
  PRIMARY KEY (provider, provider_event_id),
  CONSTRAINT billing_provider_events_subscription_fk
    FOREIGN KEY (subscription_id) REFERENCES billing_subscriptions(subscription_id) ON DELETE CASCADE,
  CONSTRAINT billing_provider_events_shape_check CHECK (
    provider ~ '^[a-z][a-z0-9-]{0,31}$'
    AND char_length(provider_event_id) BETWEEN 1 AND 255
    AND fact_kind IN (
      'trial-started', 'payment-method-updated', 'invoice-paid',
      'invoice-payment-failed', 'invoice-payment-action-required',
      'cancellation-scheduled', 'subscription-cancelled'
    )
    AND outcome IN ('applied', 'ignored')
    AND occurred_at BETWEEN 0 AND 9007199254740991
    AND applied_version BETWEEN 1 AND 2147483647
    AND recorded_at BETWEEN occurred_at AND 9007199254740991
  )
);
CREATE INDEX idx_billing_provider_events_subscription
  ON billing_provider_event_receipts(subscription_id, occurred_at, provider_event_id);

CREATE TABLE billing_reconciliation_checkpoints (
  provider text NOT NULL,
  snapshot_id text NOT NULL,
  subscription_id text NOT NULL,
  observed_at bigint NOT NULL,
  applied_version bigint NOT NULL,
  recorded_at bigint NOT NULL,
  PRIMARY KEY (provider, snapshot_id),
  CONSTRAINT billing_reconcile_subscription_fk
    FOREIGN KEY (subscription_id) REFERENCES billing_subscriptions(subscription_id) ON DELETE CASCADE,
  CONSTRAINT billing_reconcile_shape_check CHECK (
    provider ~ '^[a-z][a-z0-9-]{0,31}$'
    AND char_length(snapshot_id) BETWEEN 1 AND 255
    AND observed_at BETWEEN 0 AND 9007199254740991
    AND applied_version BETWEEN 1 AND 2147483647
    AND recorded_at BETWEEN observed_at AND 9007199254740991
  )
);
CREATE INDEX idx_billing_reconcile_subscription
  ON billing_reconciliation_checkpoints(subscription_id, observed_at, snapshot_id);

-- +goose Down
DROP TABLE billing_reconciliation_checkpoints;
DROP TABLE billing_provider_event_receipts;
DROP TABLE billing_checkout_intents;
DROP TABLE billing_subscriptions;
