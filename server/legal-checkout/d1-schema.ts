import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { personalVaults } from '../control-plane/d1-schema';

export const contractEvidence = sqliteTable(
  'contract_evidence',
  {
    accountId: text('account_id').notNull(),
    vaultId: text('vault_id').notNull(),
    evidenceId: text('evidence_id').notNull(),
    submissionId: text('submission_id').notNull(),
    offerHash: text('offer_hash').notNull(),
    offerVersion: text('offer_version').notNull(),
    disclosureVersion: text('disclosure_version').notNull(),
    serializedOffer: text('serialized_offer').notNull(),
    consent: text('consent').notNull(),
    confirmedAt: integer('confirmed_at').notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.accountId, table.vaultId, table.evidenceId],
    }),
    uniqueIndex('idx_contract_evidence_submission').on(
      table.accountId,
      table.vaultId,
      table.submissionId,
    ),
    foreignKey({
      columns: [table.accountId, table.vaultId],
      foreignColumns: [personalVaults.accountId, personalVaults.vaultId],
      name: 'contract_evidence_owner_fk',
    }).onDelete('cascade'),
    check(
      'contract_evidence_shape_check',
      sql`length(${table.evidenceId}) = 36
        AND length(${table.submissionId}) = 36
        AND length(${table.offerHash}) = 71
        AND substr(${table.offerHash}, 1, 7) = 'sha256:'
        AND length(${table.offerVersion}) BETWEEN 1 AND 128
        AND length(${table.disclosureVersion}) = 10
        AND length(${table.serializedOffer}) BETWEEN 1 AND 8192
        AND ${table.consent} = 'affirmed'
        AND ${table.confirmedAt} >= 0`,
    ),
  ],
);
