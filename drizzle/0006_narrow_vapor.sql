CREATE TABLE `billing_checkout_intents` (
	`checkout_intent_id` text PRIMARY KEY NOT NULL,
	`subscription_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_checkout_ref` text,
	`status` text NOT NULL,
	`created_at` integer NOT NULL,
	`opened_at` integer,
	FOREIGN KEY (`subscription_id`) REFERENCES `billing_subscriptions`(`subscription_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "billing_checkout_intents_shape_check" CHECK("billing_checkout_intents"."status" IN ('created', 'opened')
        AND "billing_checkout_intents"."created_at" >= 0
        AND (
          ("billing_checkout_intents"."status" = 'created' AND "billing_checkout_intents"."provider_checkout_ref" IS NULL AND "billing_checkout_intents"."opened_at" IS NULL)
          OR ("billing_checkout_intents"."status" = 'opened' AND "billing_checkout_intents"."provider_checkout_ref" IS NOT NULL AND "billing_checkout_intents"."opened_at" >= "billing_checkout_intents"."created_at")
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_billing_checkout_provider_ref` ON `billing_checkout_intents` (`provider`,`provider_checkout_ref`);--> statement-breakpoint
CREATE INDEX `idx_billing_checkout_subscription` ON `billing_checkout_intents` (`subscription_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `billing_provider_event_receipts` (
	`provider` text NOT NULL,
	`provider_event_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`fact_kind` text NOT NULL,
	`outcome` text NOT NULL,
	`occurred_at` integer NOT NULL,
	`applied_version` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `provider_event_id`),
	FOREIGN KEY (`subscription_id`) REFERENCES `billing_subscriptions`(`subscription_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "billing_provider_events_shape_check" CHECK("billing_provider_event_receipts"."fact_kind" IN (
          'trial-started', 'payment-method-updated', 'invoice-paid',
          'invoice-payment-failed', 'invoice-payment-action-required',
          'cancellation-scheduled', 'subscription-cancelled'
        )
        AND "billing_provider_event_receipts"."outcome" IN ('applied', 'ignored')
        AND "billing_provider_event_receipts"."occurred_at" >= 0 AND "billing_provider_event_receipts"."applied_version" > 0
        AND "billing_provider_event_receipts"."recorded_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_billing_provider_events_subscription` ON `billing_provider_event_receipts` (`subscription_id`,`occurred_at`,`provider_event_id`);--> statement-breakpoint
CREATE TABLE `billing_reconciliation_checkpoints` (
	`provider` text NOT NULL,
	`snapshot_id` text NOT NULL,
	`subscription_id` text NOT NULL,
	`observed_at` integer NOT NULL,
	`applied_version` integer NOT NULL,
	`recorded_at` integer NOT NULL,
	PRIMARY KEY(`provider`, `snapshot_id`),
	FOREIGN KEY (`subscription_id`) REFERENCES `billing_subscriptions`(`subscription_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "billing_reconcile_shape_check" CHECK("billing_reconciliation_checkpoints"."observed_at" >= 0 AND "billing_reconciliation_checkpoints"."applied_version" > 0 AND "billing_reconciliation_checkpoints"."recorded_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_billing_reconcile_subscription` ON `billing_reconciliation_checkpoints` (`subscription_id`,`observed_at`,`snapshot_id`);--> statement-breakpoint
CREATE TABLE `billing_subscriptions` (
	`subscription_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_customer_ref` text,
	`provider_subscription_ref` text,
	`version` integer NOT NULL,
	`status` text NOT NULL,
	`payment_method_ready` integer NOT NULL,
	`payment_method_updated_at` integer,
	`trial_started_at` integer,
	`trial_ends_at` integer,
	`trial_observed_at` integer,
	`paid_period_started_at` integer,
	`paid_period_ends_at` integer,
	`last_paid_at` integer,
	`last_paid_invoice_ref` text,
	`delinquency_reason` text,
	`delinquency_since` integer,
	`delinquency_invoice_ref` text,
	`cancel_at` integer,
	`cancellation_updated_at` integer,
	`cancelled_at` integer,
	`last_reconciled_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`account_id`,`vault_id`) REFERENCES `personal_vaults`(`account_id`,`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "billing_subscriptions_shape_check" CHECK("billing_subscriptions"."version" > 0
        AND "billing_subscriptions"."status" IN ('checkout-pending', 'trialing', 'active', 'delinquent', 'cancelled')
        AND "billing_subscriptions"."payment_method_ready" IN (0, 1)
        AND ("billing_subscriptions"."provider_customer_ref" IS NULL) = ("billing_subscriptions"."provider_subscription_ref" IS NULL)
        AND ("billing_subscriptions"."last_paid_at" IS NULL) = ("billing_subscriptions"."last_paid_invoice_ref" IS NULL)
        AND "billing_subscriptions"."created_at" >= 0 AND "billing_subscriptions"."updated_at" >= "billing_subscriptions"."created_at"
        AND ("billing_subscriptions"."status" <> 'trialing' OR (
          "billing_subscriptions"."trial_started_at" IS NOT NULL AND "billing_subscriptions"."trial_ends_at" > "billing_subscriptions"."trial_started_at"
        ))
        AND ("billing_subscriptions"."status" <> 'active' OR (
          "billing_subscriptions"."paid_period_started_at" IS NOT NULL AND "billing_subscriptions"."paid_period_ends_at" > "billing_subscriptions"."paid_period_started_at"
          AND "billing_subscriptions"."delinquency_reason" IS NULL AND "billing_subscriptions"."delinquency_since" IS NULL
          AND "billing_subscriptions"."delinquency_invoice_ref" IS NULL
        ))
        AND ("billing_subscriptions"."status" <> 'delinquent' OR (
          "billing_subscriptions"."delinquency_reason" IN ('payment-failed', 'payment-action-required')
          AND "billing_subscriptions"."delinquency_since" IS NOT NULL AND "billing_subscriptions"."delinquency_invoice_ref" IS NOT NULL
        ))
        AND ("billing_subscriptions"."status" <> 'cancelled' OR "billing_subscriptions"."cancelled_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_billing_subscriptions_owner` ON `billing_subscriptions` (`account_id`,`vault_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_billing_subscriptions_customer` ON `billing_subscriptions` (`provider`,`provider_customer_ref`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_billing_subscriptions_provider_subscription` ON `billing_subscriptions` (`provider`,`provider_subscription_ref`);--> statement-breakpoint
CREATE INDEX `idx_billing_subscriptions_status` ON `billing_subscriptions` (`status`,`updated_at`,`subscription_id`);