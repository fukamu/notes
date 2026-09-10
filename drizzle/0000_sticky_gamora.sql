CREATE TABLE `card_mutations` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_card_mutations_card_id` ON `card_mutations` (`card_id`);--> statement-breakpoint
CREATE TABLE `cards` (
	`id` text PRIMARY KEY NOT NULL,
	`display_id` integer NOT NULL,
	`title` text NOT NULL,
	`body_json` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_mutation_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cards_display_id` ON `cards` (`display_id`);--> statement-breakpoint
CREATE TABLE `conflicts` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`server_revision` integer NOT NULL,
	`local_title` text NOT NULL,
	`local_body_json` text NOT NULL,
	`server_title` text NOT NULL,
	`server_body_json` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_conflicts_card_id` ON `conflicts` (`card_id`);--> statement-breakpoint
CREATE TABLE `sync_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`next_display_id` integer NOT NULL
);
