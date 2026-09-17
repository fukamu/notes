'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  createNotesApplicationController,
  createNotesPresentationModel,
} from '@/lib/application/notes-controller';
import {
  EMPTY_NOTES_LOCATION,
  notesLocationCardId,
} from '@/lib/application/navigation';
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
  NotesPresentationActions,
  NotesPresentationModel,
} from '@/lib/application/presentation';
import type { NotesDataStore } from '@/lib/client/notes-store';

export function useNotesApplication(store: NotesDataStore): {
  model: NotesPresentationModel;
  actions: NotesPresentationActions;
} {
  const [navigator] = useState(createBrowserNotesNavigator);
  const [cardEditorIndexCache] = useState(createCardEditorIndexCache);
  const [connectionsGraphCache] = useState(createConnectionsGraphCache);
  const location = useSyncExternalStore(
    navigator.subscribe,
    navigator.getLocation,
    () => EMPTY_NOTES_LOCATION,
  );
  const controller = useMemo(
    () => createNotesApplicationController(store, navigator),
    [navigator, store],
  );
  const locationCardId = notesLocationCardId(location);
  const initialized = isNotesInitialized(store.initialization);
  const initialSyncComplete = isInitialSyncComplete(store.initialization);
  const awaitingInitialCardResolution =
    initialized &&
    locationCardId !== null &&
    !store.hasCard(locationCardId) &&
    !initialSyncComplete;

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
  const model = useMemo(
    () =>
      createNotesPresentationModel(store, location, {
        cardEditorIndex,
        connectionsGraph: { kind: 'precomputed', graph: connectionsGraph },
      }),
    [cardEditorIndex, connectionsGraph, location, store],
  );

  return {
    model: awaitingInitialCardResolution
      ? { ...model, initialized: false }
      : model,
    actions: controller,
  };
}
