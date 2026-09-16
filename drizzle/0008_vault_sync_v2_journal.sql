CREATE TABLE `vault_card_display_ids` (
	`vault_id` text NOT NULL,
	`card_id` text NOT NULL,
	`official_display_id` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `card_id`),
	FOREIGN KEY (`vault_id`,`card_id`) REFERENCES `vault_cards`(`vault_id`,`card_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_card_display_ids_value_check" CHECK("vault_card_display_ids"."official_display_id" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vault_card_display_ids_official` ON `vault_card_display_ids` (`vault_id`,`official_display_id`);--> statement-breakpoint
CREATE TABLE `vault_sync_v2_changes` (
	`vault_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`change_kind` text NOT NULL,
	`card_id` text NOT NULL,
	`conflict_id` text,
	`revision` integer NOT NULL,
	`official_display_id` integer,
	`occurred_at` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `sequence`),
	FOREIGN KEY (`vault_id`) REFERENCES `vault_sync_v2_states`(`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_sync_v2_changes_shape_check" CHECK("vault_sync_v2_changes"."sequence" > 0
        AND "vault_sync_v2_changes"."revision" > 0
        AND "vault_sync_v2_changes"."occurred_at" >= 0
        AND (
          ("vault_sync_v2_changes"."change_kind" = 'card-upsert'
            AND "vault_sync_v2_changes"."conflict_id" IS NULL
            AND "vault_sync_v2_changes"."official_display_id" > 0)
          OR ("vault_sync_v2_changes"."change_kind" = 'card-tombstone'
            AND "vault_sync_v2_changes"."conflict_id" IS NULL
            AND "vault_sync_v2_changes"."official_display_id" IS NULL)
          OR ("vault_sync_v2_changes"."change_kind" IN ('conflict-upsert', 'conflict-tombstone')
            AND "vault_sync_v2_changes"."conflict_id" IS NOT NULL
            AND "vault_sync_v2_changes"."official_display_id" IS NULL)
        ))
);
--> statement-breakpoint
CREATE TABLE `vault_sync_v2_commits` (
	`vault_id` text NOT NULL,
	`mutation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`card_id` text NOT NULL,
	`applied_revision` integer NOT NULL,
	`committed_at` integer NOT NULL,
	`state` text NOT NULL,
	PRIMARY KEY(`vault_id`, `mutation_id`),
	FOREIGN KEY (`vault_id`) REFERENCES `vault_partition_mappings`(`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_sync_v2_commits_shape_check" CHECK(length("vault_sync_v2_commits"."fingerprint") = 43
        AND "vault_sync_v2_commits"."applied_revision" > 0
        AND "vault_sync_v2_commits"."committed_at" >= 0
        AND "vault_sync_v2_commits"."state" IN ('pending', 'committed'))
);
--> statement-breakpoint
CREATE TABLE `vault_sync_v2_states` (
	`vault_id` text PRIMARY KEY NOT NULL,
	`next_display_id` integer NOT NULL,
	`next_change_sequence` integer NOT NULL,
	FOREIGN KEY (`vault_id`) REFERENCES `vault_partition_mappings`(`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_sync_v2_states_display_check" CHECK("vault_sync_v2_states"."next_display_id" > 0),
	CONSTRAINT "vault_sync_v2_states_sequence_check" CHECK("vault_sync_v2_states"."next_change_sequence" > 0)
);
