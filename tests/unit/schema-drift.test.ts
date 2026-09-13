import { readFile } from 'node:fs/promises';
import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';
import { cardMutations, cards, conflicts, syncState } from '@/db/schema';

describe('D1 schema drift', () => {
  it('keeps schema creation out of the request-time sync path', async () => {
    const [repository, handler] = await Promise.all([
      readFile('db/d1-sync.ts', 'utf8'),
      readFile('app/api/sync/handler.ts', 'utf8'),
    ]);
    expect(repository).not.toMatch(
      /CREATE\s+(?:TABLE|INDEX)|ensureSyncSchema/i,
    );
    expect(handler).not.toMatch(/CREATE\s+(?:TABLE|INDEX)|ensureSyncSchema/i);
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

  it('keeps final checks in Drizzle, migration, and snapshot', async () => {
    const migration = await readFile(
      'drizzle/0001_amazing_cannonball.sql',
      'utf8',
    );
    const snapshot = await readFile('drizzle/meta/0001_snapshot.json', 'utf8');
    for (const name of [
      'cards_display_id_check',
      'cards_revision_check',
      'sync_state_singleton_check',
      'sync_state_next_display_id_check',
    ]) {
      expect(migration).toContain(name);
      expect(snapshot).toContain(name);
    }
  });
});
