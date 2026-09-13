import { describe, expect, it } from 'vitest';
import {
  notesDatabaseName,
  vaultNotesDatabaseName,
} from '@/lib/application/notes-database-scope';
import {
  LEGACY_NOTES_SCOPE,
  type LegacyNotesScope,
} from '@/lib/application/notes-runtime';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const vaultScope: VaultNotesScope = {
  kind: 'vault',
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

describe('notes database scope', () => {
  it('preserves the fixed legacy database name', () => {
    expect(notesDatabaseName(LEGACY_NOTES_SCOPE)).toBe('fukamu-notes');
  });

  it('derives a collision-resistant account and Vault namespace without session data', () => {
    const databaseName = vaultNotesDatabaseName(vaultScope);
    expect(databaseName).toBe(
      `fukamu-notes:v1:vault:${sessionFixtureIds.accountId}:${sessionFixtureIds.vaultId}`,
    );
    expect(databaseName).not.toContain(sessionFixtureIds.sessionId);
    expect(
      notesDatabaseName({
        ...vaultScope,
        sessionId: sessionFixtureIds.nextSessionId,
        sessionEpoch: sessionFixtureIds.nextEpoch,
      }),
    ).toBe(databaseName);
    expect(
      notesDatabaseName({
        ...vaultScope,
        accountId: sessionFixtureIds.otherAccountId,
        vaultId: sessionFixtureIds.otherVaultId,
      }),
    ).not.toBe(databaseName);
  });

  it('keeps the scope input immutable', () => {
    const before = { ...vaultScope };
    notesDatabaseName(vaultScope);
    expect(vaultScope).toEqual(before);
  });

  it('keeps scope alternatives exhaustive at compile time', () => {
    const scopes: Array<LegacyNotesScope | VaultNotesScope> = [
      LEGACY_NOTES_SCOPE,
      vaultScope,
    ];
    expect(scopes.map(notesDatabaseName)).toEqual([
      'fukamu-notes',
      vaultNotesDatabaseName(vaultScope),
    ]);
  });
});
