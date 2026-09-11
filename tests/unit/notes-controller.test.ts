import { describe, expect, it, vi } from 'vitest';
import { NotesPresentation } from '@/components/notes-presentation';
import {
  createNotesApplicationController,
  createNotesPresentationModel,
  type NotesStorePort,
} from '@/lib/application/notes-controller';
import { createInMemoryNotesNavigator } from '@/lib/application/navigation';
import type { CardRecord, ConflictRecord } from '@/lib/domain/types';
import { fixtureCardId, fixtureConflictId } from '@/tests/fixtures/ids';

function card(label: string, value: number): CardRecord {
  return {
    id: fixtureCardId(label),
    displayId: { kind: 'official', value },
    title: label,
    body: [],
    createdAt: value,
    updatedAt: value,
    localRevision: 1,
    serverRevision: 1,
  };
}

function fakeStore(initialCards: CardRecord[] = []): NotesStorePort & {
  calls: string[];
} {
  const store: NotesStorePort & { calls: string[] } = {
    cards: [...initialCards],
    conflicts: [],
    initialized: true,
    saveState: 'saved',
    syncState: 'idle',
    calls: [],
    createCard: async () => {
      const created = card(
        `created-${store.cards.length}`,
        store.cards.length + 1,
      );
      store.cards = [...store.cards, created];
      store.calls.push(`create:${created.id}`);
      return created;
    },
    updateCard: (cardId, patch) => {
      store.calls.push(`update:${cardId}`);
      store.cards = store.cards.map((candidate) =>
        candidate.id === cardId ? { ...candidate, ...patch } : candidate,
      );
    },
    synchronizeNow: async () => {
      store.calls.push('sync');
    },
    resolveConflict: (conflict, choice) => {
      const existing = store.cards.find(
        (candidate) => candidate.id === conflict.cardId,
      );
      if (!existing) return undefined;
      const updated = {
        ...existing,
        title: choice === 'local' ? conflict.localTitle : conflict.serverTitle,
      };
      store.cards = store.cards.map((candidate) =>
        candidate.id === updated.id ? updated : candidate,
      );
      store.calls.push(`resolve:${choice}`);
      return updated;
    },
  };
  return store;
}

describe('notes application controller', () => {
  it('coordinates initialization and named view/card navigation', () => {
    const first = card('controller-first', 1);
    const second = card('controller-second', 2);
    const store = fakeStore([first, second]);
    const navigator = createInMemoryNotesNavigator();
    const controller = createNotesApplicationController(store, navigator);

    expect(controller.initializeNavigation()).toEqual({
      kind: 'card',
      cardId: second.id,
    });
    controller.showHistory();
    expect(navigator.getLocation()).toEqual({
      kind: 'history',
      cardId: second.id,
    });
    controller.showConnections();
    expect(navigator.getLocation()).toEqual({
      kind: 'connections',
      cardId: second.id,
    });
    controller.openCard(first.id);
    expect(navigator.getLocation()).toEqual({
      kind: 'card',
      cardId: first.id,
    });
    controller.openCard(fixtureCardId('not-in-store'));
    expect(navigator.getLocation()).toEqual({
      kind: 'card',
      cardId: first.id,
    });
  });

  it('keeps data operations navigation-free while controller actions navigate', async () => {
    const store = fakeStore();
    const navigator = createInMemoryNotesNavigator();
    const listener = vi.fn();
    navigator.subscribe(listener);

    await store.createCard();
    expect(navigator.getLocation()).toEqual({ kind: 'empty' });
    expect(listener).not.toHaveBeenCalled();

    const controller = createNotesApplicationController(store, navigator);
    await controller.createCard();
    expect(navigator.getLocation()).toEqual({
      kind: 'card',
      cardId: store.cards.at(-1)?.id,
    });
    expect(listener).toHaveBeenCalledOnce();
  });

  it('coordinates edits and conflict resolution around the current card', () => {
    const current = card('controller-current', 1);
    const store = fakeStore([current]);
    const conflict: ConflictRecord = {
      id: fixtureConflictId('controller'),
      cardId: current.id,
      serverRevision: 2,
      localTitle: 'Local',
      localBody: [],
      serverTitle: 'Server',
      serverBody: [],
      createdAt: 2,
    };
    store.conflicts = [conflict];
    const navigator = createInMemoryNotesNavigator({
      kind: 'history',
      cardId: current.id,
    });
    const controller = createNotesApplicationController(store, navigator);

    controller.updateTitle('Edited');
    expect(store.cards[0]?.title).toBe('Edited');
    expect(navigator.getLocation().kind).toBe('history');

    controller.resolveConflict(conflict.id, 'server');
    expect(store.calls).toContain('resolve:server');
    expect(navigator.getLocation()).toEqual({
      kind: 'card',
      cardId: current.id,
    });
  });

  it('derives a complete model accepted by the default presentation contract', () => {
    const current = card('presentation-current', 7);
    const store = fakeStore([current]);
    const navigator = createInMemoryNotesNavigator({
      kind: 'card',
      cardId: current.id,
    });
    const actions = createNotesApplicationController(store, navigator);
    const model = createNotesPresentationModel(store, navigator.getLocation());
    const props: Parameters<typeof NotesPresentation>[0] = { model, actions };

    expect(props.model).toMatchObject({
      activeView: 'card',
      currentCardDisplayLabel: '#7',
      availableViews: { card: true, history: true, connections: true },
    });
    expect(props.model.connections?.graph.nodes).toHaveLength(1);
  });
});
