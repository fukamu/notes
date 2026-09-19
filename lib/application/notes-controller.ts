import {
  isNotesInitialized,
  type NotesInitializationLifecycle,
} from '@/lib/application/initialization-lifecycle';
import {
  areNotesLocationsEqual,
  notesLocationCardId,
  type NotesLocation,
  type NotesNavigationIntent,
  type NotesNavigator,
} from '@/lib/application/navigation';
import type {
  ConflictChoice,
  HistoryViewModel,
  NotesPresentationActions,
  NotesPresentationModel,
  NotesViewName,
} from '@/lib/application/presentation';
import {
  projectConnectionsViewModel,
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
import type { ConnectionsGraph } from '@/lib/domain/graph';

type ConnectionsGraphSource =
  | { readonly kind: 'derive' }
  | {
      readonly kind: 'precomputed';
      readonly graph: ConnectionsGraph | null;
    };

type NotesPresentationOptions = Readonly<{
  cardEditorIndex: CardEditorCandidateIndex | null;
  connectionsGraph: ConnectionsGraphSource;
  history: HistoryViewModel | null;
  navigationPending?: boolean;
}>;

const DEFAULT_PRESENTATION_OPTIONS: NotesPresentationOptions = {
  cardEditorIndex: null,
  connectionsGraph: { kind: 'derive' },
  history: null,
  navigationPending: false,
};

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

export type NotesApplicationControllerPorts = Readonly<{
  onCardCreated: (cardId: CardId) => void;
  isActive?: () => boolean;
}>;

const DEFAULT_CONTROLLER_PORTS: NotesApplicationControllerPorts = {
  onCardCreated: () => undefined,
  isActive: () => true,
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
  ports: NotesApplicationControllerPorts = DEFAULT_CONTROLLER_PORTS,
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
      const started = navigator.getSnapshot();
      if (started.pending || ports.isActive?.() === false) return;
      const card = await store.createCard();
      const current = navigator.getSnapshot();
      const stayedAtStart =
        current.activationId === started.activationId &&
        areNotesLocationsEqual(current.location, started.location);
      const initializedCreatedCard =
        started.location.kind === 'empty' &&
        current.cause === 'initialize' &&
        current.location.kind === 'card' &&
        current.location.cardId === card.id;
      if (
        ports.isActive?.() === false ||
        current.pending ||
        (!stayedAtStart && !initializedCreatedCard)
      ) {
        return;
      }
      const destination = navigate(navigator, {
        type: 'open-card',
        cardId: card.id,
      });
      if (
        !navigator.getSnapshot().pending &&
        destination.kind === 'card' &&
        destination.cardId === card.id
      ) {
        ports.onCardCreated(card.id);
      }
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
  options: NotesPresentationOptions = DEFAULT_PRESENTATION_OPTIONS,
): NotesPresentationModel {
  const currentCardId = notesLocationCardId(location);
  const currentCard =
    store.cards.find((card) => card.id === currentCardId) ?? null;
  const view = activeView(location);
  const hasCurrentCard = currentCard !== null;

  const common = {
    initialized: isNotesInitialized(store.initialization),
    navigationPending: options.navigationPending ?? false,
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
        history:
          options.history ?? selectHistoryViewModel(store.cards, currentCardId),
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
          ? options.connectionsGraph.kind === 'precomputed'
            ? options.connectionsGraph.graph === null
              ? null
              : projectConnectionsViewModel(
                  options.connectionsGraph.graph,
                  currentCard.id,
                )
            : selectConnectionsViewModel(store.cards, currentCard.id)
          : null,
      };
  }
}
