'use client';

import { NotesPresentation } from '@/components/notes-presentation';
import { NotesProvider, useNotesDataStore } from '@/lib/client/notes-store';
import { useNotesApplication } from '@/lib/client/use-notes-application';

function NotesConnector() {
  const store = useNotesDataStore();
  const { model, actions } = useNotesApplication(store);
  return <NotesPresentation model={model} actions={actions} />;
}

export function NotesApp() {
  return (
    <NotesProvider>
      <NotesConnector />
    </NotesProvider>
  );
}
