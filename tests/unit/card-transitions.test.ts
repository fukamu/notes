import { describe, expect, it } from 'vitest';
import {
  applyCardEdit,
  createLocalCard,
  createPendingMutation,
  resolveCardConflict,
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
    'resolves the %s version with the conflict revision',
    (choice, expectedTitle, expectedBody) => {
      const original = card();
      const currentConflict = conflict();
      const originalBefore = structuredClone(original);
      const conflictBefore = structuredClone(currentConflict);

      const result = resolveCardConflict(
        original,
        currentConflict,
        choice,
        400,
      );

      expect(result).toEqual({
        ok: true,
        card: {
          ...original,
          title: expectedTitle,
          body: [{ type: 'text', text: expectedBody }],
          serverRevision: 7,
          updatedAt: 400,
          localRevision: 4,
        },
      });
      expect(original).toEqual(originalBefore);
      expect(currentConflict).toEqual(conflictBefore);
    },
  );

  it('returns a typed failure for a conflict belonging to another card', () => {
    expect(
      resolveCardConflict(
        card(),
        conflict({ cardId: fixtureCardId('other') }),
        'local',
        400,
      ),
    ).toEqual({ ok: false, reason: 'conflict-card-mismatch' });
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
});
