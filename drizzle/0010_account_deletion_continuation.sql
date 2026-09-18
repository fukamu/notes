CREATE TABLE `account_deletion_continuations` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`idempotency_key_hash` text NOT NULL,
	`secret_hash` text NOT NULL,
	`sequence` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`operation_id`) REFERENCES `account_deletion_operations`(`operation_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "account_deletion_continuations_shape_check" CHECK(length("account_deletion_continuations"."idempotency_key_hash") = 43
        AND length("account_deletion_continuations"."secret_hash") = 43
        AND "account_deletion_continuations"."sequence" BETWEEN 0 AND 2147483647
        AND "account_deletion_continuations"."created_at" >= 0
        AND "account_deletion_continuations"."expires_at" > "account_deletion_continuations"."created_at"
        AND "account_deletion_continuations"."updated_at" >= "account_deletion_continuations"."created_at"
        AND "account_deletion_continuations"."updated_at" < "account_deletion_continuations"."expires_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_account_deletion_continuations_secret` ON `account_deletion_continuations` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `idx_account_deletion_continuations_expiry` ON `account_deletion_continuations` (`expires_at`,`operation_id`);