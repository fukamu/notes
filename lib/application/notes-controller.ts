import {
  isNotesInitialized,
  type NotesInitializationLifecycle,
} from '@/lib/application/initialization-lifecycle';
import {
  notesLocationCardId,
  type NotesLocation,
  type NotesNavigationIntent,
  type NotesNavigator,
} from '@/lib/application/navigation';
import type {
  ConflictChoice,
  NotesPresentationActions,
  NotesPresentationModel,
  NotesViewName,
} from '@/lib/application/presentation';
import {
  selectCardEditorInputModel,
  selectConflictViewModels,
  selectConnectionsViewModel,
  selectHistoryViewModel,
  selectNotesStatus,
} from '@/lib/application/view-models';
import { formatDisplayId } from '@/lib/domain/display-id';
import type { CardId, ConflictId } from '@/lib/domain/id';
import type { CardEdit } from '@/lib/domain/card-transitions';
import type {
  CardRecord,
  ConflictRecord,
  SaveState,
  SyncState,
} from '@/lib/domain/types';
import type { CardEditorCandidateIndex } from '@/lib/application/card-editor-index';

export type NotesStorePort = {
  cards: CardRecord[];
  conflicts: ConflictRecord[];
  initialization: NotesInitializationLifecycle;
  saveState: SaveState;
  syncState: SyncState;
  resolvingConflictCardIds: CardId[];
  createCard: () => Promise<CardRecord>;
  hasCard: (cardId: CardId) => boolean;
  updateCard: (cardId: CardId, edit: CardEdit) => void;
  synchronizeNow: () => Promise<void>;
  resolveConflict: (
    conflict: ConflictRecord,
    choice: ConflictChoice,
  ) => CardRecord | undefined;
};

export type NotesApplicationController = NotesPresentationActions & {
  initializeNavigation: () => NotesLocation;
  reconcileNavigation: () => NotesLocation;
};

function activeView(location: NotesLocation): NotesViewName {
  return location.kind === 'empty' ? 'card' : location.kind;
}

function navigate(
  navigator: NotesNavigator,
  intent: NotesNavigationIntent,
): NotesLocation {
  return navigator.navigate(intent);
}

export function createNotesApplicationController(
  store: NotesStorePort,
  navigator: NotesNavigator,
): NotesApplicationController {
  const currentCard = () => {
    const currentCardId = notesLocationCardId(navigator.getLocation());
    return store.cards.find((card) => card.id === currentCardId);
  };

  return {
    initializeNavigation: () =>
      navigate(navigator, {
        type: 'initialize',
        cardIds: store.cards.map((card) => card.id),
      }),
    reconcileNavigation: () =>
      navigate(navigator, {
        type: 'reconcile-cards',
        cardIds: store.cards.map((card) => card.id),
      }),
    createCard: async () => {
      const card = await store.createCard();
      navigate(navigator, { type: 'open-card', cardId: card.id });
    },
    openCard: (cardId) => {
      if (!store.hasCard(cardId)) return;
      navigate(navigator, { type: 'open-card', cardId });
    },
    showCurrentCard: () => {
      navigate(navigator, { type: 'show-current-card' });
    },
    showHistory: () => {
      navigate(navigator, { type: 'show-history' });
    },
    showConnections: () => {
      navigate(navigator, { type: 'show-connections' });
    },
    updateTitle: (title) => {
      const card = currentCard();
      if (card) store.updateCard(card.id, { type: 'title', title });
    },
    updateBody: (body) => {
      const card = currentCard();
      if (card) store.updateCard(card.id, { type: 'body', body });
    },
    retrySync: () => store.synchronizeNow(),
    resolveConflict: (conflictId: ConflictId, choice: ConflictChoice) => {
      const conflict = store.conflicts.find(
        (candidate) => candidate.id === conflictId,
      );
      if (!conflict) return;
      const card = store.resolveConflict(conflict, choice);
      if (card) navigate(navigator, { type: 'open-card', cardId: card.id });
    },
  };
}

export function createNotesPresentationModel(
  store: NotesStorePort,
  location: NotesLocation,
  options: Readonly<{
    cardEditorIndex: CardEditorCandidateIndex | null;
  }> = { cardEditorIndex: null },
): NotesPresentationModel {
  const currentCardId = notesLocationCardId(location);
  const currentCard =
    store.cards.find((card) => card.id === currentCardId) ?? null;
  const view = activeView(location);
  const hasCurrentCard = currentCard !== null;

  const common = {
    initialized: isNotesInitialized(store.initialization),
    location,
    availableViews: {
      card: hasCurrentCard,
      history: true,
      connections: hasCurrentCard,
    },
    currentCard,
    currentCardDisplayLabel: currentCard
      ? formatDisplayId(currentCard.displayId)
      : null,
    status: selectNotesStatus(store.saveState, store.syncState),
  };

  switch (view) {
    case 'card':
      return {
        ...common,
        activeView: view,
        cardEditor: currentCard
          ? selectCardEditorInputModel(
              store.cards,
              currentCard,
              options.cardEditorIndex,
            )
          : null,
        history: null,
        conflicts: currentCard
          ? selectConflictViewModels(
              store.conflicts.filter(
                (conflict) => conflict.cardId === currentCard.id,
              ),
              store.cards,
              {
                resolvingCardIds: store.resolvingConflictCardIds,
                failed:
                  store.saveState === 'failed' || store.syncState === 'failed',
              },
            )
          : [],
        connections: null,
      };
    case 'history':
      return {
        ...common,
        activeView: view,
        cardEditor: null,
        history: selectHistoryViewModel(store.cards, currentCardId),
        conflicts: [],
        connections: null,
      };
    case 'connections':
      return {
        ...common,
        activeView: view,
        cardEditor: null,
        history: null,
        conflicts: [],
        connections: currentCard
          ? selectConnectionsViewModel(store.cards, currentCard.id)
          : null,
      };
  }
}
