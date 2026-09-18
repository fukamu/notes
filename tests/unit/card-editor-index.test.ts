import { describe, expect, it } from 'vitest';
import {
  createCardEditorCandidateIndex,
  maximumCardEditorCandidateResults,
  queryCardEditorCandidates,
  reconcileCardEditorCandidateIndex,
} from '@/lib/application/card-editor-index';
import { linkCandidates } from '@/lib/domain/body';
import { formatDisplayId } from '@/lib/domain/display-id';
import { visibleTitle, type CardRecord } from '@/lib/domain/types';
import { fixtureCardId } from '@/tests/fixtures/ids';

function card(
  label: string,
  displayValue: number,
  options: Partial<CardRecord> = {},
): CardRecord {
  return {
    id: fixtureCardId(label),
    displayId: { kind: 'official', value: displayValue },
    title: label,
    body: [{ type: 'text', text: `body-${label}` }],
    createdAt: displayValue,
    updatedAt: displayValue,
    localRevision: 1,
    serverRevision: 1,
    ...options,
  };
}

function legacyCandidates(
  cards: readonly CardRecord[],
  currentCardId: CardRecord['id'],
  prefix: string,
) {
  return linkCandidates(cards, currentCardId, prefix).map((candidate) => ({
    cardId: candidate.id,
    displayLabel: formatDisplayId(candidate.displayId),
    displayValue: candidate.displayId.value,
    title: visibleTitle(candidate.title),
  }));
}

describe('card editor candidate index', () => {
  it('preserves legacy filtering, numeric order, kind and stable tie breaks', () => {
    const current = card('current', 4);
    const cards = [
      card('official-32-later', 32, { createdAt: 7 }),
      current,
      card('official-321', 321),
      card('provisional-32', 32, {
        displayId: { kind: 'provisional', value: 32 },
        createdAt: 1,
      }),
      card('official-32-earlier', 32, { createdAt: 2 }),
      card('official-3-empty-title', 3, { title: '' }),
      card('official-999', 999),
    ];
    const inputOrder = cards.map((item) => item.id);
    const index = createCardEditorCandidateIndex(cards, current.id);

    for (const prefix of ['', '3', '32', '321', '999', '0', '３']) {
      expect(queryCardEditorCandidates(index, prefix)).toEqual(
        legacyCandidates(cards, current.id, prefix),
      );
    }
    expect(cards.map((item) => item.id)).toEqual(inputOrder);
    expect(index.labels).toEqual(
      cards.map((item) => ({
        cardId: item.id,
        label: `${formatDisplayId(item.displayId)} ${visibleTitle(item.title)}`,
      })),
    );
  });

  it('reuses body/revision-only input and rebuilds candidate metadata changes', () => {
    const current = card('current-reconcile', 1);
    const candidate = card('candidate-reconcile', 20);
    const cards = [current, candidate];
    const initial = createCardEditorCandidateIndex(cards, current.id);
    const bodyEditedCurrent: CardRecord = {
      ...current,
      body: [{ type: 'text', text: 'edited body' }],
      updatedAt: 99,
      localRevision: 8,
      serverRevision: 7,
    };
    const bodyOnly = [bodyEditedCurrent, candidate];

    expect(
      reconcileCardEditorCandidateIndex(initial, bodyOnly, current.id),
    ).toBe(initial);

    const renamedCandidate: CardRecord = {
      ...candidate,
      title: 'renamed candidate',
    };
    const titleChanged = [bodyEditedCurrent, renamedCandidate];
    const renamed = reconcileCardEditorCandidateIndex(
      initial,
      titleChanged,
      current.id,
    );
    expect(renamed).not.toBe(initial);
    expect(queryCardEditorCandidates(renamed, '2')[0]?.title).toBe(
      'renamed candidate',
    );

    const provisional = reconcileCardEditorCandidateIndex(
      renamed,
      [
        bodyEditedCurrent,
        {
          ...renamedCandidate,
          displayId: { kind: 'provisional', value: 21 },
        },
      ],
      current.id,
    );
    expect(queryCardEditorCandidates(provisional, '20')).toHaveLength(0);
    expect(queryCardEditorCandidates(provisional, '21')[0]?.displayLabel).toBe(
      '仮 #21',
    );
  });

  it('rebuilds for create, delete, source-order and current-card changes', () => {
    const first = card('first-structure', 1);
    const second = card('second-structure', 2);
    const third = card('third-structure', 3);
    const initialCards = [first, second];
    const initial = createCardEditorCandidateIndex(initialCards, first.id);
    const created = reconcileCardEditorCandidateIndex(
      initial,
      [...initialCards, third],
      first.id,
    );
    const reordered = reconcileCardEditorCandidateIndex(
      created,
      [third, second, first],
      first.id,
    );
    const deleted = reconcileCardEditorCandidateIndex(
      reordered,
      [third, first],
      first.id,
    );
    const newCurrent = reconcileCardEditorCandidateIndex(
      deleted,
      [third, first],
      third.id,
    );

    expect(created).not.toBe(initial);
    expect(reordered).not.toBe(created);
    expect(deleted).not.toBe(reordered);
    expect(newCurrent).not.toBe(deleted);
    expect(queryCardEditorCandidates(newCurrent, '')).toEqual(
      legacyCandidates([third, first], third.id, ''),
    );
  });

  it('rejects non-ASCII and impossible numeric prefixes without scanning', () => {
    const current = card('current-prefix', 1);
    const index = createCardEditorCandidateIndex(
      [current, card('candidate-prefix', 12)],
      current.id,
    );

    expect(queryCardEditorCandidates(index, '12x')).toEqual([]);
    expect(queryCardEditorCandidates(index, '99999999999999999999')).toEqual(
      [],
    );
  });

  it('bounds results at the active-card product limit without reordering', () => {
    const current = card('limit-current', 1);
    const candidates = Array.from(
      { length: maximumCardEditorCandidateResults + 1 },
      (_, index) => card(`limit-${index}`, index + 2),
    );
    const index = createCardEditorCandidateIndex(
      [current, ...candidates],
      current.id,
    );
    const results = queryCardEditorCandidates(index, '');

    expect(results).toHaveLength(maximumCardEditorCandidateResults);
    expect(results[0]?.displayValue).toBe(
      maximumCardEditorCandidateResults + 2,
    );
    expect(results.at(-1)?.displayValue).toBe(3);
  });
});
