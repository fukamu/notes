CREATE TABLE `vault_dek_versions` (
	`vault_id` text NOT NULL,
	`dek_version` integer NOT NULL,
	`kek_key_reference` text NOT NULL,
	`wrapped_dek` text NOT NULL,
	`is_write_key` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`vault_id`, `dek_version`),
	CONSTRAINT "vault_dek_versions_version_check" CHECK("vault_dek_versions"."dek_version" > 0),
	CONSTRAINT "vault_dek_versions_write_check" CHECK("vault_dek_versions"."is_write_key" IN (0, 1)),
	CONSTRAINT "vault_dek_versions_wrapped_check" CHECK(length("vault_dek_versions"."wrapped_dek") BETWEEN 1 AND 16384),
	CONSTRAINT "vault_dek_versions_created_at_check" CHECK("vault_dek_versions"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_vault_dek_versions_write` ON `vault_dek_versions` (`vault_id`,`is_write_key`) WHERE "vault_dek_versions"."is_write_key" = 1;--> statement-breakpoint
CREATE INDEX `idx_vault_dek_versions_created` ON `vault_dek_versions` (`vault_id`,`created_at`,`dek_version`);