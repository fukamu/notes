CREATE TABLE `entitlement_offline_leases` (
	`lease_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`session_id` text NOT NULL,
	`session_epoch` integer NOT NULL,
	`source_subscription_id` text NOT NULL,
	`source_billing_version` integer NOT NULL,
	`basis` text NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`,`vault_id`) REFERENCES `entitlement_projections`(`account_id`,`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entitlement_offline_lease_shape_check" CHECK("entitlement_offline_leases"."session_epoch" > 0 AND "entitlement_offline_leases"."source_billing_version" > 0
        AND "entitlement_offline_leases"."basis" IN ('trial', 'paid')
        AND "entitlement_offline_leases"."issued_at" >= 0 AND "entitlement_offline_leases"."expires_at" > "entitlement_offline_leases"."issued_at"
        AND "entitlement_offline_leases"."created_at" = "entitlement_offline_leases"."issued_at"
        AND ("entitlement_offline_leases"."revoked_at" IS NULL OR "entitlement_offline_leases"."revoked_at" >= "entitlement_offline_leases"."issued_at"))
);
--> statement-breakpoint
CREATE INDEX `idx_entitlement_leases_owner` ON `entitlement_offline_leases` (`account_id`,`vault_id`,`expires_at`,`lease_id`);--> statement-breakpoint
CREATE INDEX `idx_entitlement_leases_expiry` ON `entitlement_offline_leases` (`expires_at`,`revoked_at`,`lease_id`);--> statement-breakpoint
CREATE TABLE `entitlement_projections` (
	`account_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`version` integer NOT NULL,
	`source_subscription_id` text NOT NULL,
	`source_billing_version` integer NOT NULL,
	`state` text NOT NULL,
	`valid_until` integer,
	`lock_reason` text,
	`checked_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `vault_id`),
	FOREIGN KEY (`account_id`,`vault_id`) REFERENCES `personal_vaults`(`account_id`,`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "entitlement_projection_shape_check" CHECK("entitlement_projections"."version" > 0 AND "entitlement_projections"."source_billing_version" > 0
        AND "entitlement_projections"."state" IN ('trial-active', 'paid-active', 'locked')
        AND "entitlement_projections"."checked_at" >= 0 AND "entitlement_projections"."created_at" >= 0
        AND "entitlement_projections"."updated_at" = "entitlement_projections"."checked_at"
        AND "entitlement_projections"."updated_at" >= "entitlement_projections"."created_at"
        AND (
          ("entitlement_projections"."state" IN ('trial-active', 'paid-active')
            AND "entitlement_projections"."valid_until" > "entitlement_projections"."checked_at"
            AND "entitlement_projections"."lock_reason" IS NULL)
          OR ("entitlement_projections"."state" = 'locked'
            AND "entitlement_projections"."valid_until" IS NULL
            AND "entitlement_projections"."lock_reason" IN (
              'checkout-incomplete', 'payment-method-required',
              'trial-expired', 'paid-period-expired', 'payment-failed',
              'payment-action-required', 'cancelled'
            ))
        ))
);
--> statement-breakpoint
CREATE INDEX `idx_entitlement_projection_state` ON `entitlement_projections` (`state`,`checked_at`,`vault_id`);