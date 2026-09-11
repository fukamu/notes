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
import { createBrowserNotesNavigator } from '@/lib/client/browser-notes-navigator';
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
  const awaitingInitialCardResolution =
    store.initialized &&
    locationCardId !== null &&
    !store.hasCard(locationCardId) &&
    !store.initialSyncComplete;

  useEffect(() => {
    if (!store.initialized || awaitingInitialCardResolution) return;
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
    store.initialized,
  ]);

  const model = useMemo(
    () => createNotesPresentationModel(store, location),
    [location, store],
  );

  return {
    model: awaitingInitialCardResolution
      ? { ...model, initialized: false }
      : model,
    actions: controller,
  };
}
