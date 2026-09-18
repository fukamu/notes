import { describe, expect, it, vi } from 'vitest';
import { NotesPresentation } from '@/components/notes-presentation';
import { queryCardEditorCandidates } from '@/lib/application/card-editor-index';
import {
  createNotesApplicationController,
  createNotesPresentationModel,
  type NotesStorePort,
} from '@/lib/application/notes-controller';
import { createInMemoryNotesNavigator } from '@/lib/application/navigation';
import type { CardRecord, ConflictRecord } from '@/lib/domain/types';
import { fixtureCardId, fixtureConflictId } from '@/tests/fixtures/ids';
import { createNotesViewStatePorts } from '@/lib/client/notes-view-state';

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
    initialization: { stage: 'ready', loadOutcome: 'succeeded' },
    saveState: 'saved',
    syncState: 'idle',
    resolvingConflictCardIds: [],
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
    hasCard: (cardId) =>
      store.cards.some((candidate) => candidate.id === cardId),
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
      const updated =
        choice === 'current'
          ? existing
          : {
              ...existing,
              title:
                choice === 'local' ? conflict.localTitle : conflict.serverTitle,
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

    const onCardCreated = vi.fn(() => navigator.getLocation());
    const controller = createNotesApplicationController(store, navigator, {
      onCardCreated,
    });
    await controller.createCard();
    expect(navigator.getLocation()).toEqual({
      kind: 'card',
      cardId: store.cards.at(-1)?.id,
    });
    expect(listener).toHaveBeenCalledOnce();
    expect(onCardCreated).toHaveBeenCalledWith(store.cards.at(-1)?.id);
    expect(onCardCreated.mock.results[0]?.value).toEqual(
      navigator.getLocation(),
    );
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
    const props: Parameters<typeof NotesPresentation>[0] = {
      model,
      actions,
      features: {
        renderCardEditor: () => null,
        renderConnections: () => null,
        viewState: createNotesViewStatePorts(current.id),
      },
    };

    expect(props.model).toMatchObject({
      activeView: 'card',
      currentCardDisplayLabel: '#7',
      availableViews: { card: true, history: true, connections: true },
      history: null,
      connections: null,
    });
    expect(props.model.cardEditor?.cardId).toBe(current.id);

    const history = createNotesPresentationModel(store, {
      kind: 'history',
      cardId: current.id,
    });
    expect(history.activeView).toBe('history');
    expect(history.history?.items).toHaveLength(1);
    expect(history.cardEditor).toBeNull();
    expect(history.connections).toBeNull();

    const connections = createNotesPresentationModel(store, {
      kind: 'connections',
      cardId: current.id,
    });
    expect(connections.activeView).toBe('connections');
    expect(connections.connections?.nodes).toHaveLength(1);
    expect(connections.cardEditor).toBeNull();
    expect(connections.history).toBeNull();
  });

  it('does not read inactive history or connections bodies in card view', () => {
    const current = card('active-current', 1);
    const inactiveBase = card('inactive-selector-trap', 2);
    const inactive: CardRecord = {
      ...inactiveBase,
      get body(): CardRecord['body'] {
        throw new Error('inactive selector read a non-current body');
      },
    };
    const store = fakeStore([current, inactive]);

    const model = createNotesPresentationModel(store, {
      kind: 'card',
      cardId: current.id,
    });

    expect(model.activeView).toBe('card');
    expect(
      model.cardEditor
        ? queryCardEditorCandidates(model.cardEditor.candidateIndex, '')
        : [],
    ).toHaveLength(1);
    expect(model.history).toBeNull();
    expect(model.connections).toBeNull();
  });

  it('projects a precomputed connections graph without reading card bodies again', () => {
    const currentBase = card('precomputed-current', 1);
    const current: CardRecord = {
      ...currentBase,
      get body(): CardRecord['body'] {
        throw new Error('precomputed projection re-read a card body');
      },
    };
    const store = fakeStore([current]);

    const model = createNotesPresentationModel(
      store,
      { kind: 'connections', cardId: current.id },
      {
        cardEditorIndex: null,
        connectionsGraph: {
          kind: 'precomputed',
          graph: { nodes: [{ card: current }], edges: [] },
        },
        history: null,
      },
    );

    expect(model.activeView).toBe('connections');
    expect(model.connections).toMatchObject({
      currentCardId: current.id,
      nodes: [{ cardId: current.id, current: true }],
      edges: [],
    });
  });

  it('uses a precomputed history model without reading card bodies again', () => {
    const currentBase = card('precomputed-history-current', 1);
    const current: CardRecord = {
      ...currentBase,
      get body(): CardRecord['body'] {
        throw new Error('precomputed history re-read a card body');
      },
    };
    const store = fakeStore([current]);
    const history = {
      currentCardId: current.id,
      items: [
        {
          cardId: current.id,
          displayLabel: '#1',
          displayValue: 1,
          title: current.title,
          preview: 'precomputed preview',
          current: true,
        },
      ],
    };

    const model = createNotesPresentationModel(
      store,
      { kind: 'history', cardId: current.id },
      {
        cardEditorIndex: null,
        connectionsGraph: { kind: 'derive' },
        history,
      },
    );

    expect(model.activeView).toBe('history');
    expect(model.history).toBe(history);
  });
});
