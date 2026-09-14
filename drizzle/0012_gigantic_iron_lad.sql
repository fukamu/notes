CREATE TABLE `vault_quota_reservations` (
	`account_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`reservation_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`card_id` text NOT NULL,
	`change_kind` text NOT NULL,
	`card_delta` integer NOT NULL,
	`plaintext_byte_delta` integer NOT NULL,
	`charged_card_delta` integer NOT NULL,
	`charged_plaintext_byte_delta` integer NOT NULL,
	`usage_revision_at_reservation` integer NOT NULL,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`reconcile_after` integer NOT NULL,
	`finalized_at` integer,
	`finalized_usage_revision` integer,
	PRIMARY KEY(`account_id`, `vault_id`, `reservation_id`),
	FOREIGN KEY (`account_id`,`vault_id`) REFERENCES `personal_vaults`(`account_id`,`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_quota_reservations_shape_check" CHECK(length("vault_quota_reservations"."reservation_id") = 36
        AND length("vault_quota_reservations"."fingerprint") = 43
        AND length("vault_quota_reservations"."card_id") = 36
        AND "vault_quota_reservations"."usage_revision_at_reservation" > 0
        AND "vault_quota_reservations"."created_at" >= 0
        AND "vault_quota_reservations"."reconcile_after" > "vault_quota_reservations"."created_at"
        AND (
          ("vault_quota_reservations"."change_kind" = 'create'
            AND "vault_quota_reservations"."card_delta" = 1
            AND "vault_quota_reservations"."plaintext_byte_delta" >= 0
            AND "vault_quota_reservations"."charged_card_delta" = 1
            AND "vault_quota_reservations"."charged_plaintext_byte_delta" = "vault_quota_reservations"."plaintext_byte_delta")
          OR ("vault_quota_reservations"."change_kind" = 'update'
            AND "vault_quota_reservations"."card_delta" = 0
            AND "vault_quota_reservations"."charged_card_delta" = 0
            AND "vault_quota_reservations"."charged_plaintext_byte_delta" =
              CASE WHEN "vault_quota_reservations"."plaintext_byte_delta" > 0
                THEN "vault_quota_reservations"."plaintext_byte_delta" ELSE 0 END)
          OR ("vault_quota_reservations"."change_kind" = 'delete'
            AND "vault_quota_reservations"."card_delta" = -1
            AND "vault_quota_reservations"."plaintext_byte_delta" <= 0
            AND "vault_quota_reservations"."charged_card_delta" = 0
            AND "vault_quota_reservations"."charged_plaintext_byte_delta" = 0)
        )
        AND (
          ("vault_quota_reservations"."state" = 'reserved'
            AND "vault_quota_reservations"."finalized_at" IS NULL
            AND "vault_quota_reservations"."finalized_usage_revision" IS NULL)
          OR ("vault_quota_reservations"."state" IN ('committed', 'released')
            AND "vault_quota_reservations"."finalized_at" >= "vault_quota_reservations"."created_at"
            AND "vault_quota_reservations"."finalized_usage_revision" > "vault_quota_reservations"."usage_revision_at_reservation")
        ))
);
--> statement-breakpoint
CREATE INDEX `idx_vault_quota_reservations_reconcile` ON `vault_quota_reservations` (`account_id`,`vault_id`,`state`,`reconcile_after`,`reservation_id`);--> statement-breakpoint
CREATE TABLE `vault_quota_usage` (
	`account_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`revision` integer NOT NULL,
	`active_cards` integer NOT NULL,
	`plaintext_bytes` integer NOT NULL,
	`last_transition_reservation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`account_id`, `vault_id`),
	FOREIGN KEY (`account_id`,`vault_id`) REFERENCES `personal_vaults`(`account_id`,`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "vault_quota_usage_shape_check" CHECK("vault_quota_usage"."revision" > 0
        AND "vault_quota_usage"."active_cards" >= 0
        AND "vault_quota_usage"."plaintext_bytes" >= 0
        AND ("vault_quota_usage"."last_transition_reservation_id" IS NULL
          OR length("vault_quota_usage"."last_transition_reservation_id") = 36)
        AND "vault_quota_usage"."created_at" >= 0
		AND "vault_quota_usage"."updated_at" >= "vault_quota_usage"."created_at")
);
--> statement-breakpoint
CREATE TRIGGER vault_quota_finalize_usage
    BEFORE UPDATE OF state ON vault_quota_reservations
    FOR EACH ROW
    WHEN OLD.state = 'reserved' AND NEW.state IN ('committed', 'released')
    BEGIN
      UPDATE vault_quota_usage SET
        revision = NEW.finalized_usage_revision,
        active_cards = active_cards + CASE
          WHEN NEW.state = 'committed' THEN NEW.card_delta ELSE 0 END,
        plaintext_bytes = plaintext_bytes + CASE
          WHEN NEW.state = 'committed' THEN NEW.plaintext_byte_delta ELSE 0 END,
        last_transition_reservation_id = NEW.reservation_id,
        updated_at = NEW.finalized_at
      WHERE account_id = NEW.account_id AND vault_id = NEW.vault_id
        AND revision = NEW.finalized_usage_revision - 1
        AND active_cards + CASE
          WHEN NEW.state = 'committed' THEN NEW.card_delta ELSE 0 END >= 0
        AND plaintext_bytes + CASE
          WHEN NEW.state = 'committed' THEN NEW.plaintext_byte_delta ELSE 0 END >= 0;
      SELECT CASE WHEN changes() <> 1 THEN RAISE(IGNORE) END;
    END;
