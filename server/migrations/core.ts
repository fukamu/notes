import {
  arrayDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  type Decoder,
  type InferDecoder,
} from '../../lib/codec/core';

export type MigrationDefinition = {
  readonly id: string;
  readonly checksum: string;
  readonly statements: readonly [string, ...string[]];
};

export type AppliedMigration = {
  readonly id: string;
  readonly checksum: string;
  readonly appliedAt: number;
};

const migrationIdDecoder = refineDecoder(
  stringDecoder({ minLength: 1, maxLength: 128 }),
  (value) => /^[0-9]{4}_[a-z0-9_]+$/.test(value),
  'expected a versioned migration ID',
);
const migrationChecksumDecoder = refineDecoder(
  stringDecoder({ minLength: 71, maxLength: 71 }),
  (value) => /^sha256:[a-f0-9]{64}$/.test(value),
  'expected a SHA-256 migration checksum',
);

const appliedMigrationRowDecoder = objectDecoder({
  migration_id: migrationIdDecoder,
  checksum: migrationChecksumDecoder,
  applied_at: safeIntegerDecoder({ minimum: 0 }),
});

export const appliedMigrationRowsDecoder: Decoder<
  InferDecoder<typeof appliedMigrationRowDecoder>[]
> = arrayDecoder(appliedMigrationRowDecoder, {
  maxLength: 1_024,
  uniqueBy: (row) => row.migration_id,
});

export type MigrationPlan =
  | {
      readonly kind: 'ready';
      readonly pending: readonly MigrationDefinition[];
    }
  | {
      readonly kind: 'invalid-manifest';
      readonly reason:
        | 'duplicate-id'
        | 'invalid-id'
        | 'invalid-checksum'
        | 'invalid-statement'
        | 'unordered';
    }
  | {
      readonly kind: 'schema-drift';
      readonly reason:
        | 'unknown-applied-migration'
        | 'checksum-mismatch'
        | 'non-prefix-history';
      readonly migrationId: string;
    };

export function planMigrations(
  manifest: readonly MigrationDefinition[],
  applied: readonly AppliedMigration[],
): MigrationPlan {
  const manifestProblem = validateManifest(manifest);
  if (manifestProblem !== undefined) return manifestProblem;

  for (const [index, existing] of applied.entries()) {
    const expected = manifest[index];
    if (expected === undefined) {
      return {
        kind: 'schema-drift',
        reason: 'unknown-applied-migration',
        migrationId: existing.id,
      };
    }
    if (existing.id !== expected.id) {
      const known = manifest.find((migration) => migration.id === existing.id);
      return {
        kind: 'schema-drift',
        reason: known ? 'non-prefix-history' : 'unknown-applied-migration',
        migrationId: existing.id,
      };
    }
    if (existing.checksum !== expected.checksum) {
      return {
        kind: 'schema-drift',
        reason: 'checksum-mismatch',
        migrationId: existing.id,
      };
    }
  }

  return { kind: 'ready', pending: manifest.slice(applied.length) };
}

function validateManifest(
  manifest: readonly MigrationDefinition[],
): Extract<MigrationPlan, { kind: 'invalid-manifest' }> | undefined {
  const ids = new Set<string>();
  let previousId: string | undefined;
  for (const migration of manifest) {
    if (!/^[0-9]{4}_[a-z0-9_]+$/.test(migration.id)) {
      return { kind: 'invalid-manifest', reason: 'invalid-id' };
    }
    if (ids.has(migration.id)) {
      return { kind: 'invalid-manifest', reason: 'duplicate-id' };
    }
    if (previousId !== undefined && migration.id <= previousId) {
      return { kind: 'invalid-manifest', reason: 'unordered' };
    }
    if (!/^sha256:[a-f0-9]{64}$/.test(migration.checksum)) {
      return { kind: 'invalid-manifest', reason: 'invalid-checksum' };
    }
    if (
      migration.statements.some(
        (statement) =>
          statement.trim() === '' ||
          /^(?:begin|commit|rollback)\b/i.test(statement.trim()),
      )
    ) {
      return { kind: 'invalid-manifest', reason: 'invalid-statement' };
    }
    ids.add(migration.id);
    previousId = migration.id;
  }
  return undefined;
}
