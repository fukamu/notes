import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

export const accounts = sqliteTable(
  'accounts',
  {
    accountId: text('account_id').primaryKey(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [check('accounts_created_at_check', sql`${table.createdAt} >= 0`)],
);

export const personalVaults = sqliteTable(
  'personal_vaults',
  {
    vaultId: text('vault_id').primaryKey(),
    accountId: text('account_id').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_personal_vaults_account').on(table.accountId),
    uniqueIndex('idx_personal_vaults_owner').on(table.accountId, table.vaultId),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.accountId],
      name: 'personal_vaults_account_fk',
    }).onDelete('cascade'),
    check('personal_vaults_created_at_check', sql`${table.createdAt} >= 0`),
  ],
);

export const identities = sqliteTable(
  'identities',
  {
    identityId: text('identity_id').primaryKey(),
    accountId: text('account_id').notNull(),
    provider: text('provider').notNull(),
    issuer: text('issuer').notNull(),
    subject: text('subject').notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (table) => [
    uniqueIndex('idx_identities_issuer_subject').on(
      table.issuer,
      table.subject,
    ),
    index('idx_identities_account').on(table.accountId),
    foreignKey({
      columns: [table.accountId],
      foreignColumns: [accounts.accountId],
      name: 'identities_account_fk',
    }).onDelete('cascade'),
    check(
      'identities_provider_check',
      sql`${table.provider} IN ('google-oidc', 'email-otp')`,
    ),
    check('identities_created_at_check', sql`${table.createdAt} >= 0`),
  ],
);

export const sessions = sqliteTable(
  'sessions',
  {
    sessionId: text('session_id').primaryKey(),
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    sessionEpoch: integer('session_epoch').notNull(),
    issuedAt: integer('issued_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    revocationReason: text('revocation_reason'),
  },
  (table) => [
    uniqueIndex('idx_sessions_token_hash').on(table.tokenHash),
    index('idx_sessions_account').on(table.accountId),
    index('idx_sessions_vault').on(table.vaultId),
    index('idx_sessions_expires_at').on(table.expiresAt),
    foreignKey({
      columns: [table.accountId, table.vaultId],
      foreignColumns: [personalVaults.accountId, personalVaults.vaultId],
      name: 'sessions_owner_fk',
    }).onDelete('cascade'),
    check('sessions_epoch_check', sql`${table.sessionEpoch} > 0`),
    check(
      'sessions_timeline_check',
      sql`${table.issuedAt} >= 0 AND ${table.expiresAt} > ${table.issuedAt}`,
    ),
    check(
      'sessions_revocation_check',
      sql`(
        ${table.revokedAt} IS NULL AND ${table.revocationReason} IS NULL
      ) OR (
        ${table.revokedAt} >= ${table.issuedAt}
        AND ${table.revocationReason} IN ('logout', 'rotated', 'security')
      )`,
    ),
  ],
);

export const schemaMigrations = sqliteTable(
  'schema_migrations',
  {
    migrationId: text('migration_id').primaryKey(),
    checksum: text('checksum').notNull(),
    appliedAt: integer('applied_at').notNull(),
  },
  (table) => [
    check('schema_migrations_applied_at_check', sql`${table.appliedAt} >= 0`),
  ],
);
