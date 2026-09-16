import { BoundaryDecodeError, objectDecoder } from '../../lib/codec/core';
import {
  appliedMigrationRowsDecoder,
  planMigrations,
  type AppliedMigration,
  type MigrationDefinition,
} from './core';
import type { D1DatabaseBinding } from '../../db/d1-types';

const migrationLedgerStatement = `CREATE TABLE IF NOT EXISTS schema_migrations (
  migration_id TEXT PRIMARY KEY NOT NULL,
  checksum TEXT NOT NULL,
  applied_at INTEGER NOT NULL CONSTRAINT schema_migrations_applied_at_check CHECK (applied_at >= 0)
)`;

const d1ResultsDecoder = objectDecoder(
  { results: appliedMigrationRowsDecoder },
  { unknownFields: 'allow' },
);

export type D1MigrationResult =
  | { readonly kind: 'applied'; readonly migrationIds: readonly string[] }
  | { readonly kind: 'up-to-date' }
  | {
      readonly kind: 'rejected';
      readonly reason: 'invalid-manifest' | 'schema-drift';
      readonly detail: string;
    };

export async function runD1Migrations(input: {
  readonly database: D1DatabaseBinding;
  readonly manifest: readonly MigrationDefinition[];
  readonly appliedAt: number;
}): Promise<D1MigrationResult> {
  if (!Number.isSafeInteger(input.appliedAt) || input.appliedAt < 0) {
    return {
      kind: 'rejected',
      reason: 'invalid-manifest',
      detail: 'invalid appliedAt',
    };
  }

  await input.database.prepare(migrationLedgerStatement).run();
  const rawRows: unknown = await input.database
    .prepare(
      'SELECT migration_id, checksum, applied_at FROM schema_migrations ORDER BY migration_id ASC',
    )
    .all();
  const decoded = d1ResultsDecoder.decode(rawRows);
  if (!decoded.ok) {
    throw new BoundaryDecodeError('D1 migration ledger', decoded.issues);
  }
  const applied: AppliedMigration[] = decoded.value.results.map((row) => ({
    id: row.migration_id,
    checksum: row.checksum,
    appliedAt: row.applied_at,
  }));
  const plan = planMigrations(input.manifest, applied);
  if (plan.kind === 'invalid-manifest') {
    return { kind: 'rejected', reason: plan.kind, detail: plan.reason };
  }
  if (plan.kind === 'schema-drift') {
    return {
      kind: 'rejected',
      reason: plan.kind,
      detail: `${plan.reason}:${plan.migrationId}`,
    };
  }
  if (plan.pending.length === 0) return { kind: 'up-to-date' };

  const appliedIds: string[] = [];
  for (const migration of plan.pending) {
    await input.database.batch([
      ...migration.statements.map((statement) =>
        input.database.prepare(statement),
      ),
      input.database
        .prepare(
          'INSERT INTO schema_migrations(migration_id, checksum, applied_at) VALUES (?, ?, ?)',
        )
        .bind(migration.id, migration.checksum, input.appliedAt),
    ]);
    appliedIds.push(migration.id);
  }
  return { kind: 'applied', migrationIds: appliedIds };
}
