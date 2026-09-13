CREATE TABLE `vault_encrypted_objects` (
	`vault_id` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`object_revision` integer NOT NULL,
	`write_id` text NOT NULL,
	`object_key` text NOT NULL,
	`plaintext_bytes` integer NOT NULL,
	`ciphertext_bytes` integer NOT NULL,
	`crypto_version` text NOT NULL,
	`dek_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `object_type`, `object_id`, `object_revision`),
	FOREIGN KEY (`vault_id`) REFERENCES `vault_partition_mappings`(`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_encrypted_objects_shape_check" CHECK("vault_encrypted_objects"."object_type" IN ('card', 'conflict')
        AND "vault_encrypted_objects"."object_revision" > 0
        AND length("vault_encrypted_objects"."object_key") = 50
        AND "vault_encrypted_objects"."plaintext_bytes" >= 0
        AND "vault_encrypted_objects"."ciphertext_bytes" > 0
        AND "vault_encrypted_objects"."crypto_version" = 'fukamu-envelope-aes-256-gcm/v1'
        AND "vault_encrypted_objects"."dek_version" > 0
        AND "vault_encrypted_objects"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vault_encrypted_objects_write` ON `vault_encrypted_objects` (`vault_id`,`write_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vault_encrypted_objects_key` ON `vault_encrypted_objects` (`vault_id`,`object_key`);--> statement-breakpoint
CREATE INDEX `idx_vault_encrypted_objects_current` ON `vault_encrypted_objects` (`vault_id`,`object_type`,`object_id`,`object_revision`);--> statement-breakpoint
CREATE TABLE `vault_encrypted_write_intents` (
	`vault_id` text NOT NULL,
	`write_id` text NOT NULL,
	`object_type` text NOT NULL,
	`object_id` text NOT NULL,
	`expected_revision` integer,
	`object_revision` integer NOT NULL,
	`object_key` text NOT NULL,
	`plaintext_bytes` integer NOT NULL,
	`crypto_version` text NOT NULL,
	`dek_version` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `write_id`),
	FOREIGN KEY (`vault_id`) REFERENCES `vault_partition_mappings`(`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_encrypted_write_intents_shape_check" CHECK("vault_encrypted_write_intents"."object_type" IN ('card', 'conflict')
        AND ("vault_encrypted_write_intents"."expected_revision" IS NULL OR "vault_encrypted_write_intents"."expected_revision" > 0)
        AND "vault_encrypted_write_intents"."object_revision" > 0
        AND length("vault_encrypted_write_intents"."object_key") = 50
        AND "vault_encrypted_write_intents"."plaintext_bytes" >= 0
        AND "vault_encrypted_write_intents"."crypto_version" = 'fukamu-envelope-aes-256-gcm/v1'
        AND "vault_encrypted_write_intents"."dek_version" > 0
        AND "vault_encrypted_write_intents"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vault_encrypted_write_intents_target` ON `vault_encrypted_write_intents` (`vault_id`,`object_type`,`object_id`,`object_revision`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vault_encrypted_write_intents_key` ON `vault_encrypted_write_intents` (`vault_id`,`object_key`);--> statement-breakpoint
CREATE TABLE `vault_object_delete_outbox` (
	`vault_id` text NOT NULL,
	`object_key` text NOT NULL,
	`attempt_count` integer NOT NULL,
	`next_attempt_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `object_key`),
	CONSTRAINT "vault_object_delete_outbox_attempt_check" CHECK("vault_object_delete_outbox"."attempt_count" >= 0),
	CONSTRAINT "vault_object_delete_outbox_next_attempt_check" CHECK("vault_object_delete_outbox"."next_attempt_at" >= 0),
	CONSTRAINT "vault_object_delete_outbox_created_at_check" CHECK("vault_object_delete_outbox"."created_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_vault_object_delete_outbox_ready` ON `vault_object_delete_outbox` (`vault_id`,`next_attempt_at`,`object_key`);