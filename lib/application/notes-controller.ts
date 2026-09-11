import type {
  NotesNavigator,
  NotesLocation,
} from '@/lib/application/navigation';
import {
  notesLocationCardId,
  type NotesNavigationIntent,
} from '@/lib/application/navigation';
import type {
  ConflictChoice,
  NotesPresentationActions,
  NotesPresentationModel,
  NotesViewName,
} from '@/lib/application/presentation';
import {
  selectConflictViewModel,
  selectConnectionsViewModel,
  selectHistoryViewModel,
  selectNotesStatus,
} from '@/lib/application/view-models';
import { formatDisplayId } from '@/lib/domain/display-id';
import type { CardId, ConflictId } from '@/lib/domain/id';
import type {
  BodySegment,
  CardRecord,
  ConflictRecord,
  SaveState,
  SyncState,
} from '@/lib/domain/types';

export type NotesStorePort = {
  cards: CardRecord[];
  conflicts: ConflictRecord[];
  initialized: boolean;
  saveState: SaveState;
  syncState: SyncState;
  createCard: () => Promise<CardRecord>;
  updateCard: (
    cardId: CardId,
    patch: { title?: string; body?: BodySegment[] },
  ) => void;
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
      if (!store.cards.some((card) => card.id === cardId)) return;
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
      if (card) store.updateCard(card.id, { title });
    },
    updateBody: (body) => {
      const card = currentCard();
      if (card) store.updateCard(card.id, { body });
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
): NotesPresentationModel {
  const currentCardId = notesLocationCardId(location);
  const currentCard =
    store.cards.find((card) => card.id === currentCardId) ?? null;
  const view = activeView(location);
  const hasCurrentCard = currentCard !== null;

  return {
    initialized: store.initialized,
    location,
    activeView: view,
    availableViews: {
      card: hasCurrentCard,
      history: true,
      connections: hasCurrentCard,
    },
    cards: store.cards,
    currentCard,
    currentCardDisplayLabel: currentCard
      ? formatDisplayId(currentCard.displayId)
      : null,
    history: selectHistoryViewModel(store.cards, currentCardId),
    conflicts: currentCard
      ? store.conflicts
          .filter((conflict) => conflict.cardId === currentCard.id)
          .map((conflict) => selectConflictViewModel(conflict, store.cards))
      : [],
    connections: currentCard
      ? selectConnectionsViewModel(store.cards, currentCard.id)
      : null,
    status: selectNotesStatus(store.saveState, store.syncState),
  };
}
