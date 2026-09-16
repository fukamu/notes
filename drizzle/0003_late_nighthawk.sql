CREATE TABLE `vault_cards` (
	`vault_id` text NOT NULL,
	`card_id` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `card_id`),
	FOREIGN KEY (`vault_id`) REFERENCES `vault_partition_mappings`(`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_cards_revision_check" CHECK("vault_cards"."revision" > 0),
	CONSTRAINT "vault_cards_updated_at_check" CHECK("vault_cards"."updated_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_vault_cards_updated` ON `vault_cards` (`vault_id`,`updated_at`,`card_id`);--> statement-breakpoint
CREATE TABLE `vault_conflicts` (
	`vault_id` text NOT NULL,
	`conflict_id` text NOT NULL,
	`card_id` text NOT NULL,
	`server_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `conflict_id`),
	FOREIGN KEY (`vault_id`,`card_id`) REFERENCES `vault_cards`(`vault_id`,`card_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_conflicts_revision_check" CHECK("vault_conflicts"."server_revision" > 0),
	CONSTRAINT "vault_conflicts_created_at_check" CHECK("vault_conflicts"."created_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_vault_conflicts_card` ON `vault_conflicts` (`vault_id`,`card_id`,`conflict_id`);--> statement-breakpoint
CREATE TABLE `vault_mutation_receipts` (
	`vault_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`card_id` text NOT NULL,
	`applied_revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `mutation_id`),
	FOREIGN KEY (`vault_id`,`card_id`) REFERENCES `vault_cards`(`vault_id`,`card_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_mutation_receipts_revision_check" CHECK("vault_mutation_receipts"."applied_revision" > 0),
	CONSTRAINT "vault_mutation_receipts_created_at_check" CHECK("vault_mutation_receipts"."created_at" >= 0)
);
--> statement-breakpoint
CREATE INDEX `idx_vault_mutation_receipts_card` ON `vault_mutation_receipts` (`vault_id`,`card_id`,`mutation_id`);--> statement-breakpoint
CREATE TABLE `vault_partition_mappings` (
	`vault_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`partition_id` text NOT NULL,
	`routing_revision` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "vault_partition_mappings_partition_check" CHECK(length("vault_partition_mappings"."partition_id") BETWEEN 1 AND 64),
	CONSTRAINT "vault_partition_mappings_revision_check" CHECK("vault_partition_mappings"."routing_revision" > 0),
	CONSTRAINT "vault_partition_mappings_updated_at_check" CHECK("vault_partition_mappings"."updated_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vault_partition_mappings_owner` ON `vault_partition_mappings` (`account_id`,`vault_id`);--> statement-breakpoint
CREATE INDEX `idx_vault_partition_mappings_partition_vault` ON `vault_partition_mappings` (`partition_id`,`vault_id`);