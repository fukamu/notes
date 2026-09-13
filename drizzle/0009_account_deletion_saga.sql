CREATE TABLE `account_deletion_operations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`revision` integer NOT NULL,
	`state` text NOT NULL,
	`current_step` text,
	`attempt` integer NOT NULL,
	`not_before` integer,
	`lease_expires_at` integer,
	`failure_code` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	CONSTRAINT "account_deletion_operations_shape_check" CHECK("account_deletion_operations"."revision" > 0
        AND "account_deletion_operations"."attempt" >= 0
        AND "account_deletion_operations"."created_at" >= 0
        AND "account_deletion_operations"."updated_at" >= "account_deletion_operations"."created_at"
        AND ("account_deletion_operations"."current_step" IS NULL OR "account_deletion_operations"."current_step" IN (
          'revoke-sessions', 'cancel-subscription', 'delete-vault-data',
          'delete-private-objects', 'finalize-account'
        ))
        AND ("account_deletion_operations"."failure_code" IS NULL OR length("account_deletion_operations"."failure_code") BETWEEN 1 AND 64)
        AND (
          ("account_deletion_operations"."state" = 'ready'
            AND "account_deletion_operations"."current_step" IS NOT NULL
            AND "account_deletion_operations"."not_before" >= "account_deletion_operations"."updated_at"
            AND "account_deletion_operations"."lease_expires_at" IS NULL
            AND "account_deletion_operations"."failure_code" IS NULL
            AND "account_deletion_operations"."completed_at" IS NULL)
          OR ("account_deletion_operations"."state" = 'running'
            AND "account_deletion_operations"."current_step" IS NOT NULL
            AND "account_deletion_operations"."attempt" > 0
            AND "account_deletion_operations"."not_before" IS NULL
            AND "account_deletion_operations"."lease_expires_at" > "account_deletion_operations"."updated_at"
            AND "account_deletion_operations"."failure_code" IS NULL
            AND "account_deletion_operations"."completed_at" IS NULL)
          OR ("account_deletion_operations"."state" = 'retry-wait'
            AND "account_deletion_operations"."current_step" IS NOT NULL
            AND "account_deletion_operations"."attempt" > 0
            AND "account_deletion_operations"."not_before" >= "account_deletion_operations"."updated_at"
            AND "account_deletion_operations"."lease_expires_at" IS NULL
            AND "account_deletion_operations"."failure_code" IS NOT NULL
            AND "account_deletion_operations"."completed_at" IS NULL)
          OR ("account_deletion_operations"."state" = 'terminal-failure'
            AND "account_deletion_operations"."current_step" IS NOT NULL
            AND "account_deletion_operations"."attempt" > 0
            AND "account_deletion_operations"."not_before" IS NULL
            AND "account_deletion_operations"."lease_expires_at" IS NULL
            AND "account_deletion_operations"."failure_code" IS NOT NULL
            AND "account_deletion_operations"."completed_at" IS NULL)
          OR ("account_deletion_operations"."state" = 'completed'
            AND "account_deletion_operations"."current_step" IS NULL
            AND "account_deletion_operations"."attempt" = 0
            AND "account_deletion_operations"."not_before" IS NULL
            AND "account_deletion_operations"."lease_expires_at" IS NULL
            AND "account_deletion_operations"."failure_code" IS NULL
            AND "account_deletion_operations"."completed_at" = "account_deletion_operations"."updated_at")
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_deletion_operations_account` ON `account_deletion_operations` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_account_deletion_operations_ready` ON `account_deletion_operations` (`state`,`not_before`,`operation_id`);--> statement-breakpoint
CREATE TABLE `account_deletion_step_receipts` (
	`operation_id` text NOT NULL,
	`step` text NOT NULL,
	`completed_at` integer NOT NULL,
	PRIMARY KEY(`operation_id`, `step`),
	FOREIGN KEY (`operation_id`) REFERENCES `account_deletion_operations`(`operation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_deletion_receipts_shape_check" CHECK("account_deletion_step_receipts"."step" IN (
          'revoke-sessions', 'cancel-subscription', 'delete-vault-data',
          'delete-private-objects', 'finalize-account'
        ) AND "account_deletion_step_receipts"."completed_at" >= 0)
);
