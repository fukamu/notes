/** @vitest-environment happy-dom */

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { NotesPresentationModel } from '@/lib/application/presentation';
import { useNotesApplication } from '@/lib/client/use-notes-application';
import type { NotesDataStore } from '@/lib/client/notes-store';
import type { CardRecord } from '@/lib/domain/types';
import { fixtureCardId } from '@/tests/fixtures/ids';

let root: Root | undefined;
let observedModel: NotesPresentationModel | undefined;

beforeAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = undefined;
  }
  observedModel = undefined;
  window.history.replaceState(null, '', '/');
  document.body.replaceChildren();
});

function card(label: string, value: number): CardRecord {
  return {
    id: fixtureCardId(label),
    displayId: { kind: 'official', value },
    title: label,
    body: [{ type: 'text', text: `Body ${label}` }],
    createdAt: value,
    updatedAt: value,
    localRevision: 1,
    serverRevision: 1,
  };
}

function storeFor(
  cards: CardRecord[],
  overrides: Partial<Pick<NotesDataStore, 'saveState' | 'syncState'>> = {},
): NotesDataStore {
  return {
    cards,
    conflicts: [],
    initialization: { stage: 'ready', loadOutcome: 'succeeded' },
    saveState: overrides.saveState ?? 'saved',
    syncState: overrides.syncState ?? 'idle',
    resolvingConflictCardIds: [],
    createCard: async () => {
      const existing = cards[0];
      if (!existing) throw new Error('Fixture cannot create an empty card');
      return existing;
    },
    hasCard: (cardId) => cards.some((candidate) => candidate.id === cardId),
    updateCard: () => undefined,
    synchronizeNow: async () => undefined,
    resolveConflict: () => undefined,
  };
}

function observeModel(model: NotesPresentationModel): void {
  observedModel = model;
}

function Harness({ store }: { store: NotesDataStore }) {
  const model = useNotesApplication(store).model;
  useEffect(() => observeModel(model), [model]);
  return null;
}

function render(store: NotesDataStore): NotesPresentationModel {
  const container = document.querySelector('#root');
  if (!(container instanceof HTMLDivElement)) {
    throw new Error('Missing notes application test root');
  }
  root ??= createRoot(container);
  act(() => root?.render(createElement(Harness, { store })));
  if (!observedModel) throw new Error('Notes application did not render');
  return observedModel;
}

function open(pathname: string): void {
  window.history.pushState(null, '', pathname);
  act(() => {
    window.dispatchEvent(new PopStateEvent('popstate'));
  });
}

describe('notes application history projection', () => {
  it('reuses history for state-only updates and invalidates cards/current card', () => {
    const first = card('history-hook-first', 1);
    const second = card('history-hook-second', 2);
    const cards = [first, second];
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, '', `/cards/${first.id}/history`);

    const initial = render(storeFor(cards));
    expect(initial.activeView).toBe('history');
    if (initial.activeView !== 'history') return;
    const initialHistory = initial.history;

    const saving = render(storeFor(cards, { saveState: 'saving' }));
    expect(saving.activeView).toBe('history');
    expect(saving.history).toBe(initialHistory);
    expect(saving.status).toMatchObject({ kind: 'saving', label: '保存中' });

    const changedCards = render(storeFor([...cards]));
    expect(changedCards.activeView).toBe('history');
    expect(changedCards.history).not.toBe(initialHistory);
    const changedCardsHistory = changedCards.history;

    open(`/cards/${second.id}/history`);
    if (!observedModel) throw new Error('Location update did not render');
    expect(observedModel.activeView).toBe('history');
    expect(observedModel.history).not.toBe(changedCardsHistory);
    expect(observedModel.history?.currentCardId).toBe(second.id);
  });

  it('does not calculate history outside the history tab', () => {
    const current = card('history-hook-card-view', 1);
    const inactiveBase = card('history-hook-inactive', 2);
    const inactive: CardRecord = {
      ...inactiveBase,
      get body(): CardRecord['body'] {
        throw new Error('card view calculated inactive history');
      },
    };
    document.body.innerHTML = '<div id="root"></div>';
    window.history.replaceState(null, '', `/cards/${current.id}`);

    const model = render(storeFor([current, inactive]));

    expect(model.activeView).toBe('card');
    expect(model.history).toBeNull();
  });
});
