'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import {
  createNotesApplicationController,
  createNotesPresentationModel,
} from '@/lib/application/notes-controller';
import {
  notesLocationCardId,
  SERVER_NOTES_NAVIGATION_SNAPSHOT,
} from '@/lib/application/navigation';
import type { NotesCameraPosition } from '@/lib/application/navigation-camera-session';
import {
  isInitialSyncComplete,
  isNotesInitialized,
} from '@/lib/application/initialization-lifecycle';
import { createBrowserNotesNavigator } from '@/lib/client/browser-notes-navigator';
import { createCardEditorIndexCache } from '@/lib/client/card-editor-index-cache';
import {
  createConnectionsGraphCache,
  selectConnectionsGraphForLocation,
} from '@/lib/client/connections-graph-cache';
import type {
  EditorFocusIntent,
  NotesPresentationActions,
  NotesPresentationModel,
} from '@/lib/application/presentation';
import { selectHistoryViewModel } from '@/lib/application/view-models';
import type { NotesDataStore } from '@/lib/client/notes-store';

type OwnedEditorFocusIntent = Readonly<{
  owner: NotesDataStore['createCard'];
  nextRequestId: number;
  intent: EditorFocusIntent | null;
}>;

export function useNotesApplication(store: NotesDataStore): {
  model: NotesPresentationModel;
  actions: NotesPresentationActions;
  editorFocusIntent: EditorFocusIntent | null;
  consumeEditorFocusIntent: (requestId: number) => void;
  connectionsCameraPosition: NotesCameraPosition | null;
} {
  const [navigator] = useState(createBrowserNotesNavigator);
  const [cardEditorIndexCache] = useState(createCardEditorIndexCache);
  const [connectionsGraphCache] = useState(createConnectionsGraphCache);
  const [ownedEditorFocusIntent, setOwnedEditorFocusIntent] =
    useState<OwnedEditorFocusIntent | null>(null);
  const navigation = useSyncExternalStore(
    navigator.subscribe,
    navigator.getSnapshot,
    () => SERVER_NOTES_NAVIGATION_SNAPSHOT,
  );
  const location = navigation.location;
  const connectionsCameraPosition = useMemo(
    () =>
      location.kind === 'connections'
        ? navigator.cameraSession.bind({
            entryId: navigation.entryId,
            activationId: navigation.activationId,
            currentCardId: location.cardId,
            cause: navigation.cause,
          })
        : null,
    [
      location,
      navigation.activationId,
      navigation.cause,
      navigation.entryId,
      navigator.cameraSession,
    ],
  );
  const publishEditorFocusIntent = useCallback(
    (cardId: EditorFocusIntent['cardId']) => {
      setOwnedEditorFocusIntent((current) => {
        const requestId = (current?.nextRequestId ?? 0) + 1;
        return {
          owner: store.createCard,
          nextRequestId: requestId,
          intent: { requestId, cardId, target: 'title' },
        };
      });
    },
    [store.createCard],
  );
  const controller = useMemo(
    () =>
      createNotesApplicationController(store, navigator, {
        onCardCreated: publishEditorFocusIntent,
      }),
    [navigator, publishEditorFocusIntent, store],
  );
  const locationCardId = notesLocationCardId(location);
  const initialized = isNotesInitialized(store.initialization);
  const initialSyncComplete = isInitialSyncComplete(store.initialization);
  const awaitingInitialCardResolution =
    initialized &&
    locationCardId !== null &&
    !store.hasCard(locationCardId) &&
    !initialSyncComplete;
  const editorFocusIntent =
    ownedEditorFocusIntent?.owner === store.createCard &&
    ownedEditorFocusIntent.intent !== null &&
    location.kind === 'card' &&
    location.cardId === ownedEditorFocusIntent.intent.cardId
      ? ownedEditorFocusIntent.intent
      : null;
  const consumeEditorFocusIntent = useCallback(
    (requestId: number) => {
      setOwnedEditorFocusIntent((current) =>
        current?.owner === store.createCard &&
        current.intent?.requestId === requestId
          ? { ...current, intent: null }
          : current,
      );
    },
    [store.createCard],
  );
  const discardEditorFocusIntent = useCallback((requestId: number) => {
    setOwnedEditorFocusIntent((current) =>
      current?.intent?.requestId === requestId
        ? { ...current, intent: null }
        : current,
    );
  }, []);

  useEffect(() => {
    const pending = ownedEditorFocusIntent?.intent;
    const currentLocation = navigator.getLocation();
    if (
      !pending ||
      (ownedEditorFocusIntent.owner === store.createCard &&
        currentLocation.kind === 'card' &&
        currentLocation.cardId === pending.cardId)
    ) {
      return;
    }
    queueMicrotask(() => discardEditorFocusIntent(pending.requestId));
  }, [
    discardEditorFocusIntent,
    location,
    navigator,
    ownedEditorFocusIntent,
    store.createCard,
  ]);

  useEffect(
    () => () => {
      cardEditorIndexCache.clear();
      connectionsGraphCache.clear();
    },
    [cardEditorIndexCache, connectionsGraphCache],
  );

  useEffect(() => {
    if (!initialized || awaitingInitialCardResolution) return;
    if (navigator.getLocation().kind === 'empty') {
      controller.initializeNavigation();
    } else {
      controller.reconcileNavigation();
    }
  }, [
    awaitingInitialCardResolution,
    controller,
    location,
    navigator,
    store.cards,
    initialized,
  ]);

  const cardEditorIndex = useMemo(
    () =>
      location.kind === 'card'
        ? cardEditorIndexCache.select(store.cards, location.cardId)
        : null,
    [cardEditorIndexCache, location, store.cards],
  );
  const connectionsGraph = useMemo(
    () =>
      selectConnectionsGraphForLocation(
        connectionsGraphCache,
        store.cards,
        location,
      ),
    [connectionsGraphCache, location, store.cards],
  );
  const history = useMemo(
    () =>
      location.kind === 'history'
        ? selectHistoryViewModel(store.cards, locationCardId)
        : null,
    [store.cards, location.kind, locationCardId],
  );
  const model = useMemo(
    () =>
      createNotesPresentationModel(store, location, {
        cardEditorIndex,
        connectionsGraph: { kind: 'precomputed', graph: connectionsGraph },
        history,
      }),
    [cardEditorIndex, connectionsGraph, history, location, store],
  );

  return {
    model: awaitingInitialCardResolution
      ? { ...model, initialized: false }
      : model,
    actions: controller,
    editorFocusIntent,
    consumeEditorFocusIntent,
    connectionsCameraPosition,
  };
}
