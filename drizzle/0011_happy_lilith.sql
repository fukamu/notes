CREATE TABLE `vault_dek_rotation_operations` (
	`vault_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`operation_id` text NOT NULL,
	`revision` integer NOT NULL,
	`source_version` integer NOT NULL,
	`target_version` integer NOT NULL,
	`state` text NOT NULL,
	`kek_key_reference` text,
	`wrapped_dek` text,
	`key_created_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`completed_at` integer,
	FOREIGN KEY (`account_id`,`vault_id`) REFERENCES `personal_vaults`(`account_id`,`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_dek_rotation_shape_check" CHECK("vault_dek_rotation_operations"."revision" BETWEEN 1 AND 3
        AND "vault_dek_rotation_operations"."source_version" > 0
        AND "vault_dek_rotation_operations"."target_version" = "vault_dek_rotation_operations"."source_version" + 1
        AND "vault_dek_rotation_operations"."created_at" >= 0
        AND "vault_dek_rotation_operations"."updated_at" >= "vault_dek_rotation_operations"."created_at"
        AND (
          ("vault_dek_rotation_operations"."state" = 'generating' AND "vault_dek_rotation_operations"."revision" = 1
            AND "vault_dek_rotation_operations"."kek_key_reference" IS NULL
            AND "vault_dek_rotation_operations"."wrapped_dek" IS NULL
            AND "vault_dek_rotation_operations"."key_created_at" IS NULL
            AND "vault_dek_rotation_operations"."completed_at" IS NULL)
          OR ("vault_dek_rotation_operations"."state" = 'promoting' AND "vault_dek_rotation_operations"."revision" = 2
            AND "vault_dek_rotation_operations"."kek_key_reference" IS NOT NULL
            AND length("vault_dek_rotation_operations"."wrapped_dek") BETWEEN 1 AND 16384
            AND "vault_dek_rotation_operations"."key_created_at" BETWEEN "vault_dek_rotation_operations"."created_at" AND "vault_dek_rotation_operations"."updated_at"
            AND "vault_dek_rotation_operations"."completed_at" IS NULL)
          OR ("vault_dek_rotation_operations"."state" = 'completed' AND "vault_dek_rotation_operations"."revision" = 3
            AND "vault_dek_rotation_operations"."kek_key_reference" IS NOT NULL
            AND length("vault_dek_rotation_operations"."wrapped_dek") BETWEEN 1 AND 16384
            AND "vault_dek_rotation_operations"."key_created_at" BETWEEN "vault_dek_rotation_operations"."created_at" AND "vault_dek_rotation_operations"."updated_at"
            AND "vault_dek_rotation_operations"."completed_at" = "vault_dek_rotation_operations"."updated_at")
        ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vault_dek_rotation_operation` ON `vault_dek_rotation_operations` (`operation_id`);--> statement-breakpoint
CREATE INDEX `idx_vault_dek_rotation_state` ON `vault_dek_rotation_operations` (`state`,`updated_at`,`vault_id`);