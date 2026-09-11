PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_cards` (
	`id` text PRIMARY KEY NOT NULL,
	`display_id` integer NOT NULL,
	`title` text NOT NULL,
	`body_json` text NOT NULL,
	`revision` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_mutation_id` text NOT NULL,
	CONSTRAINT "cards_display_id_check" CHECK("__new_cards"."display_id" > 0),
	CONSTRAINT "cards_revision_check" CHECK("__new_cards"."revision" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_cards`("id", "display_id", "title", "body_json", "revision", "created_at", "updated_at", "last_mutation_id") SELECT "id", "display_id", "title", "body_json", "revision", "created_at", "updated_at", "last_mutation_id" FROM `cards`;--> statement-breakpoint
DROP TABLE `cards`;--> statement-breakpoint
ALTER TABLE `__new_cards` RENAME TO `cards`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `idx_cards_display_id` ON `cards` (`display_id`);--> statement-breakpoint
CREATE TABLE `__new_sync_state` (
	`singleton` integer PRIMARY KEY NOT NULL,
	`next_display_id` integer NOT NULL,
	CONSTRAINT "sync_state_singleton_check" CHECK("__new_sync_state"."singleton" = 1),
	CONSTRAINT "sync_state_next_display_id_check" CHECK("__new_sync_state"."next_display_id" > 0)
);
--> statement-breakpoint
INSERT INTO `__new_sync_state`("singleton", "next_display_id") SELECT "singleton", "next_display_id" FROM `sync_state`;--> statement-breakpoint
DROP TABLE `sync_state`;--> statement-breakpoint
ALTER TABLE `__new_sync_state` RENAME TO `sync_state`;