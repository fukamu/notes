import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { personalVaults } from '../control-plane/d1-schema';

export const termsConsentEvidence = sqliteTable(
  'terms_consent_evidence',
  {
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    consentId: text('consent_id').notNull(),
    submissionId: text('submission_id').notNull(),
    termsVersion: text('terms_version').notNull(),
    termsHash: text('terms_hash').notNull(),
    serializedTerms: text('serialized_terms').notNull(),
    consent: text('consent').notNull(),
    acceptedAt: integer('accepted_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.vaultId, table.consentId],
    }),
    uniqueIndex('idx_terms_consent_submission').on(
      table.accountId,
      table.vaultId,
      table.submissionId,
    ),
    index('idx_terms_consent_latest').on(
      table.accountId,
      table.vaultId,
      table.acceptedAt,
      table.consentId,
    ),
    foreignKey({
      columns: [table.accountId, table.vaultId],
      foreignColumns: [personalVaults.accountId, personalVaults.vaultId],
      name: 'terms_consent_owner_fk',
    }).onDelete('cascade'),
    check(
      'terms_consent_shape_check',
      sql`length(${table.consentId}) = 36
        AND length(${table.submissionId}) = 36
        AND length(${table.termsVersion}) = 19
        AND substr(${table.termsVersion}, 1, 9) = 'terms-v1:'
        AND length(${table.termsHash}) = 71
        AND substr(${table.termsHash}, 1, 7) = 'sha256:'
        AND length(${table.serializedTerms}) BETWEEN 1 AND 65536
        AND ${table.consent} = 'affirmed'
        AND ${table.acceptedAt} >= 0`,
    ),
  ],
);
