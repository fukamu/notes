import { describe, expect, it } from 'vitest';
import {
  applyCardEdit,
  createLocalCard,
  createPendingMutation,
  resolveCardConflicts,
} from '@/lib/domain/card-transitions';
import type {
  BodySegment,
  CardRecord,
  ConflictRecord,
} from '@/lib/domain/types';
import {
  fixtureCardId,
  fixtureConflictId,
  fixtureMutationId,
} from '@/tests/fixtures/ids';

function card(overrides: Partial<CardRecord> = {}): CardRecord {
  return {
    id: fixtureCardId('card'),
    displayId: { kind: 'official', value: 4 },
    title: 'before',
    body: [{ type: 'text', text: 'body before' }],
    createdAt: 100,
    updatedAt: 200,
    localRevision: 3,
    serverRevision: 2,
    ...overrides,
  };
}

function conflict(overrides: Partial<ConflictRecord> = {}): ConflictRecord {
  return {
    id: fixtureConflictId('conflict'),
    cardId: fixtureCardId('card'),
    serverRevision: 7,
    localTitle: 'local title',
    localBody: [{ type: 'text', text: 'local body' }],
    serverTitle: 'server title',
    serverBody: [{ type: 'text', text: 'server body' }],
    createdAt: 250,
    ...overrides,
  };
}

describe('pure card transitions', () => {
  it('creates a local card from an injected ID and timestamp', () => {
    const existing = [
      card({ displayId: { kind: 'official', value: 5 } }),
      card({
        id: fixtureCardId('provisional'),
        displayId: { kind: 'provisional', value: 8 },
        serverRevision: null,
      }),
    ];
    const before = structuredClone(existing);

    const created = createLocalCard({
      cards: existing,
      cardId: fixtureCardId('new'),
      now: 300,
    });

    expect(created).toEqual({
      id: fixtureCardId('new'),
      displayId: { kind: 'provisional', value: 9 },
      title: '',
      body: [],
      createdAt: 300,
      updatedAt: 300,
      localRevision: 1,
      serverRevision: null,
    });
    expect(existing).toEqual(before);
  });

  it('rejects invalid generated timestamps and exhausted display IDs', () => {
    expect(() =>
      createLocalCard({
        cards: [],
        cardId: fixtureCardId('new'),
        now: -1,
      }),
    ).toThrow(/card timestamp/);
    expect(() =>
      createLocalCard({
        cards: [
          card({
            displayId: {
              kind: 'official',
              value: Number.MAX_SAFE_INTEGER,
            },
          }),
        ],
        cardId: fixtureCardId('new'),
        now: 1,
      }),
    ).toThrow(/next provisional display ID/);
  });

  it('applies exactly one typed title or body edit without changing inputs', () => {
    const original = card();
    const originalBefore = structuredClone(original);
    const body: BodySegment[] = [
      { type: 'text', text: 'after' },
      { type: 'link', targetCardId: fixtureCardId('target') },
    ];
    const bodyBefore = structuredClone(body);

    const titleEdited = applyCardEdit(
      original,
      { type: 'title', title: 'after title' },
      301,
    );
    const bodyEdited = applyCardEdit(original, { type: 'body', body }, 302);

    expect(titleEdited).toEqual({
      ...original,
      title: 'after title',
      updatedAt: 301,
      localRevision: 4,
    });
    expect(bodyEdited).toEqual({
      ...original,
      body,
      updatedAt: 302,
      localRevision: 4,
    });
    expect(original).toEqual(originalBefore);
    expect(body).toEqual(bodyBefore);
  });

  it.each([
    ['local', 'local title', 'local body'],
    ['server', 'server title', 'server body'],
  ] as const)(
    'resolves the %s version while retaining the latest known revision',
    (choice, expectedTitle, expectedBody) => {
      const original = card({ serverRevision: 9 });
      const currentConflict = conflict();
      const originalBefore = structuredClone(original);
      const conflictBefore = structuredClone(currentConflict);

      const result = resolveCardConflicts(
        original,
        [currentConflict],
        currentConflict.id,
        choice,
        400,
      );

      expect(result).toEqual({
        ok: true,
        card: {
          ...original,
          title: expectedTitle,
          body: [{ type: 'text', text: expectedBody }],
          serverRevision: 9,
          updatedAt: 400,
          localRevision: 4,
        },
        conflictIds: [currentConflict.id],
      });
      expect(original).toEqual(originalBefore);
      expect(currentConflict).toEqual(conflictBefore);
    },
  );

  it('keeps the current input and resolves every known conflict for the card', () => {
    const original = card({
      title: 'typing now',
      body: [{ type: 'text', text: 'latest input' }],
      serverRevision: 8,
    });
    const older = conflict({
      id: fixtureConflictId('older'),
      serverRevision: 4,
    });
    const newer = conflict({
      id: fixtureConflictId('newer'),
      serverRevision: 7,
    });

    expect(
      resolveCardConflicts(
        original,
        [older, newer, older],
        older.id,
        'current',
        401,
      ),
    ).toEqual({
      ok: true,
      card: {
        ...original,
        updatedAt: 401,
        localRevision: 4,
      },
      conflictIds: [older.id, newer.id],
    });
  });

  it('recovers the newest revision preserved by conflict evidence', () => {
    const original = card({ serverRevision: 3 });
    const older = conflict({
      id: fixtureConflictId('older-revision'),
      serverRevision: 5,
    });
    const newest = conflict({
      id: fixtureConflictId('newest-revision'),
      serverRevision: 8,
    });

    const result = resolveCardConflicts(
      original,
      [older, newest],
      older.id,
      'local',
      402,
    );

    expect(result).toMatchObject({
      ok: true,
      card: { serverRevision: 8 },
      conflictIds: [older.id, newest.id],
    });
  });

  it('returns a typed failure for a conflict belonging to another card', () => {
    expect(
      resolveCardConflicts(
        card(),
        [conflict({ cardId: fixtureCardId('other') })],
        fixtureConflictId('conflict'),
        'local',
        400,
      ),
    ).toEqual({ ok: false, reason: 'conflict-card-mismatch' });
  });

  it('rejects an empty set or a selected conflict outside the set', () => {
    const source = card();
    expect(
      resolveCardConflicts(
        source,
        [],
        fixtureConflictId('missing'),
        'current',
        400,
      ),
    ).toEqual({ ok: false, reason: 'no-conflicts' });
    expect(
      resolveCardConflicts(
        source,
        [conflict()],
        fixtureConflictId('missing'),
        'current',
        400,
      ),
    ).toEqual({ ok: false, reason: 'selected-conflict-missing' });
  });
});

describe('pure pending mutation construction', () => {
  it('constructs the existing upsert shape from injected values', () => {
    const source = card();
    const before = structuredClone(source);
    const mutationId = fixtureMutationId('upsert');

    expect(
      createPendingMutation(source, mutationId, { kind: 'upsert' }),
    ).toEqual({
      ok: true,
      mutation: {
        mutationId,
        cardId: source.id,
        kind: 'upsert',
        baseServerRevision: 2,
        title: 'before',
        body: source.body,
        createdAt: 100,
        updatedAt: 200,
        conflictIds: [],
      },
    });
    expect(source).toEqual(before);
  });

  it('constructs a resolve only when a server revision exists', () => {
    const source = card();
    const mutationId = fixtureMutationId('resolve');
    const conflictId = fixtureConflictId('resolve');

    expect(
      createPendingMutation(source, mutationId, {
        kind: 'resolve',
        conflictIds: [conflictId],
      }),
    ).toEqual({
      ok: true,
      mutation: {
        mutationId,
        cardId: source.id,
        kind: 'resolve',
        baseServerRevision: 2,
        title: 'before',
        body: source.body,
        createdAt: 100,
        updatedAt: 200,
        conflictIds: [conflictId],
      },
    });
    expect(
      createPendingMutation(
        card({
          displayId: { kind: 'provisional', value: 4 },
          serverRevision: null,
        }),
        mutationId,
        { kind: 'resolve', conflictIds: [conflictId] },
      ),
    ).toEqual({ ok: false, reason: 'missing-server-revision' });
  });

  it('retains and unions pending resolve intent when later edits are saved', () => {
    const source = card({ title: 'latest title', updatedAt: 240 });
    const firstId = fixtureConflictId('first-resolve');
    const secondId = fixtureConflictId('second-resolve');
    const existingResult = createPendingMutation(
      card(),
      fixtureMutationId('existing-resolve'),
      { kind: 'resolve', conflictIds: [firstId] },
    );
    if (!existingResult.ok) throw new Error('resolve fixture was rejected');

    const edited = createPendingMutation(
      source,
      fixtureMutationId('edited-after-resolve'),
      { kind: 'upsert' },
      existingResult.mutation,
    );
    expect(edited).toMatchObject({
      ok: true,
      mutation: {
        kind: 'resolve',
        title: 'latest title',
        conflictIds: [firstId],
      },
    });

    const extended = createPendingMutation(
      source,
      fixtureMutationId('extended-resolve'),
      { kind: 'resolve', conflictIds: [secondId, firstId] },
      existingResult.mutation,
    );
    expect(extended).toMatchObject({
      ok: true,
      mutation: {
        kind: 'resolve',
        conflictIds: [firstId, secondId],
      },
    });
  });
});
