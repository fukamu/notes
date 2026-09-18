CREATE TABLE `accounts` (
	`account_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "accounts_created_at_check" CHECK("accounts"."created_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE `identities` (
	`identity_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider` text NOT NULL,
	`issuer` text NOT NULL,
	`subject` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "identities_provider_check" CHECK("identities"."provider" IN ('google-oidc', 'email-otp')),
	CONSTRAINT "identities_created_at_check" CHECK("identities"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_identities_issuer_subject` ON `identities` (`issuer`,`subject`);--> statement-breakpoint
CREATE INDEX `idx_identities_account` ON `identities` (`account_id`);--> statement-breakpoint
CREATE TABLE `personal_vaults` (
	`vault_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`account_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "personal_vaults_created_at_check" CHECK("personal_vaults"."created_at" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_personal_vaults_account` ON `personal_vaults` (`account_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `idx_personal_vaults_owner` ON `personal_vaults` (`account_id`,`vault_id`);--> statement-breakpoint
CREATE TABLE `schema_migrations` (
	`migration_id` text PRIMARY KEY NOT NULL,
	`checksum` text NOT NULL,
	`applied_at` integer NOT NULL,
	CONSTRAINT "schema_migrations_applied_at_check" CHECK("schema_migrations"."applied_at" >= 0)
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`session_id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`vault_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`session_epoch` integer NOT NULL,
	`issued_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`revocation_reason` text,
	FOREIGN KEY (`account_id`,`vault_id`) REFERENCES `personal_vaults`(`account_id`,`vault_id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "sessions_epoch_check" CHECK("sessions"."session_epoch" > 0),
	CONSTRAINT "sessions_timeline_check" CHECK("sessions"."issued_at" >= 0 AND "sessions"."expires_at" > "sessions"."issued_at"),
	CONSTRAINT "sessions_revocation_check" CHECK((
        "sessions"."revoked_at" IS NULL AND "sessions"."revocation_reason" IS NULL
      ) OR (
        "sessions"."revoked_at" >= "sessions"."issued_at"
        AND "sessions"."revocation_reason" IN ('logout', 'rotated', 'security')
      ))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `idx_sessions_token_hash` ON `sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `idx_sessions_account` ON `sessions` (`account_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_vault` ON `sessions` (`vault_id`);--> statement-breakpoint
CREATE INDEX `idx_sessions_expires_at` ON `sessions` (`expires_at`);