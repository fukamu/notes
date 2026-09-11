import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import {
  cardMutations,
  cards,
  conflicts,
  syncSchemaStatements,
  syncState,
} from '@/db/schema';

function normalize(statement: string): string {
  return statement
    .replaceAll('`', '')
    .replaceAll('"', '')
    .replaceAll(/\b(?:sync_state|cards)\./g, '')
    .replaceAll(/\bif not exists\b/gi, '')
    .replaceAll(/\s+/g, ' ')
    .replaceAll(/\s*([(),;])\s*/g, '$1')
    .replace(/;$/, '')
    .trim()
    .toLowerCase();
}

function withoutChecks(statement: string): string {
  return statement.replaceAll(/\s+constraint\s+\w+\s+check\s*\([^)]*\)/gi, '');
}

describe('D1 schema drift', () => {
  it('keeps runtime tables and indexes equivalent to the base migration', async () => {
    const migration = await readFile('drizzle/0000_sticky_gamora.sql', 'utf8');
    const migrationStatements = migration
      .split('--> statement-breakpoint')
      .map(normalize)
      .filter(Boolean)
      .sort();
    const runtimeStatements = syncSchemaStatements
      .filter((statement) => !statement.startsWith('INSERT'))
      .map(withoutChecks)
      .map(normalize)
      .sort();
    expect(runtimeStatements).toEqual(migrationStatements);
  });

  it('keeps Drizzle columns and indexes aligned with the SQL contract', () => {
    const contract = [
      {
        table: syncState,
        columns: ['singleton', 'next_display_id'],
        indexes: [],
        checks: [
          'sync_state_singleton_check',
          'sync_state_next_display_id_check',
        ],
      },
      {
        table: cards,
        columns: [
          'id',
          'display_id',
          'title',
          'body_json',
          'revision',
          'created_at',
          'updated_at',
          'last_mutation_id',
        ],
        indexes: ['idx_cards_display_id'],
        checks: ['cards_display_id_check', 'cards_revision_check'],
      },
      {
        table: cardMutations,
        columns: ['id', 'card_id', 'created_at'],
        indexes: ['idx_card_mutations_card_id'],
        checks: [],
      },
      {
        table: conflicts,
        columns: [
          'id',
          'card_id',
          'server_revision',
          'local_title',
          'local_body_json',
          'server_title',
          'server_body_json',
          'created_at',
        ],
        indexes: ['idx_conflicts_card_id'],
        checks: [],
      },
    ];

    for (const expected of contract) {
      const actual = getTableConfig(expected.table);
      expect(actual.columns.map((column) => column.name)).toEqual(
        expected.columns,
      );
      expect(actual.columns.every((column) => column.notNull)).toBe(true);
      expect(actual.indexes.map((index) => index.config.name)).toEqual(
        expected.indexes,
      );
      expect(actual.checks.map((check) => check.name)).toEqual(expected.checks);
    }
  });

  it('keeps final checks in Drizzle, runtime DDL, migration, and snapshot', async () => {
    const migration = await readFile(
      'drizzle/0001_amazing_cannonball.sql',
      'utf8',
    );
    const snapshot = await readFile('drizzle/meta/0001_snapshot.json', 'utf8');
    const runtime = syncSchemaStatements.join('\n');
    for (const name of [
      'cards_display_id_check',
      'cards_revision_check',
      'sync_state_singleton_check',
      'sync_state_next_display_id_check',
    ]) {
      expect(migration).toContain(name);
      expect(snapshot).toContain(name);
      expect(runtime).toContain(name);
    }
  });
});
