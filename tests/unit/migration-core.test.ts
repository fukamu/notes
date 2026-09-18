import { describe, expect, it } from 'vitest';
import {
  planMigrations,
  type MigrationDefinition,
} from '@/server/migrations/core';

const migrationOne: MigrationDefinition = {
  id: '0001_accounts',
  checksum: `sha256:${'a'.repeat(64)}`,
  statements: ['CREATE TABLE accounts(id TEXT)'],
};
const migrationTwo: MigrationDefinition = {
  id: '0002_sessions',
  checksum: `sha256:${'b'.repeat(64)}`,
  statements: ['CREATE TABLE sessions(id TEXT)'],
};
const migrations = [migrationOne, migrationTwo] as const;

describe('migration planning', () => {
  it('returns only the unapplied ordered suffix', () => {
    expect(
      planMigrations(migrations, [
        {
          id: migrationOne.id,
          checksum: migrationOne.checksum,
          appliedAt: 1,
        },
      ]),
    ).toEqual({ kind: 'ready', pending: [migrationTwo] });
  });

  it('rejects checksum, unknown-history, and non-prefix schema drift', () => {
    expect(
      planMigrations(migrations, [
        {
          id: migrationOne.id,
          checksum: `sha256:${'f'.repeat(64)}`,
          appliedAt: 1,
        },
      ]),
    ).toMatchObject({ kind: 'schema-drift', reason: 'checksum-mismatch' });
    expect(
      planMigrations(migrations, [
        {
          id: '0000_unknown',
          checksum: `sha256:${'a'.repeat(64)}`,
          appliedAt: 1,
        },
      ]),
    ).toMatchObject({
      kind: 'schema-drift',
      reason: 'unknown-applied-migration',
    });
    expect(
      planMigrations(migrations, [
        {
          id: migrationTwo.id,
          checksum: migrationTwo.checksum,
          appliedAt: 1,
        },
      ]),
    ).toMatchObject({ kind: 'schema-drift', reason: 'non-prefix-history' });
  });

  it('rejects unordered, duplicate, malformed, and transaction-owning manifests', () => {
    expect(planMigrations([...migrations].reverse(), [])).toMatchObject({
      kind: 'invalid-manifest',
      reason: 'unordered',
    });
    expect(planMigrations([migrationOne, migrationOne], [])).toMatchObject({
      kind: 'invalid-manifest',
      reason: 'duplicate-id',
    });
    expect(
      planMigrations([{ ...migrationOne, checksum: 'not-a-checksum' }], []),
    ).toMatchObject({ kind: 'invalid-manifest', reason: 'invalid-checksum' });
    expect(
      planMigrations([{ ...migrationOne, statements: ['BEGIN'] }], []),
    ).toMatchObject({ kind: 'invalid-manifest', reason: 'invalid-statement' });
  });
});
