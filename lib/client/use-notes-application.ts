'use client';

import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  createNotesApplicationController,
  createNotesPresentationModel,
} from '@/lib/application/notes-controller';
import {
  createInMemoryNotesNavigator,
  EMPTY_NOTES_LOCATION,
} from '@/lib/application/navigation';
import type {
  NotesPresentationActions,
  NotesPresentationModel,
} from '@/lib/application/presentation';
import type { NotesDataStore } from '@/lib/client/notes-store';

export function useNotesApplication(store: NotesDataStore): {
  model: NotesPresentationModel;
  actions: NotesPresentationActions;
} {
  const [navigator] = useState(createInMemoryNotesNavigator);
  const location = useSyncExternalStore(
    navigator.subscribe,
    navigator.getLocation,
    () => EMPTY_NOTES_LOCATION,
  );
  const controller = useMemo(
    () => createNotesApplicationController(store, navigator),
    [navigator, store],
  );

  useEffect(() => {
    if (!store.initialized) return;
    if (navigator.getLocation().kind === 'empty') {
      controller.initializeNavigation();
    } else {
      controller.reconcileNavigation();
    }
  }, [controller, navigator, store.cards, store.initialized]);

  return {
    model: useMemo(
      () => createNotesPresentationModel(store, location),
      [location, store],
    ),
    actions: controller,
  };
}
