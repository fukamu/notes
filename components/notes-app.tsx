'use client';

import { useMemo, useState } from 'react';
import type { ComponentType } from 'react';
import {
  BodyEditor,
  defaultCardEditorPresentation,
} from '@/components/body-editor';
import { BodyEditorAdapter } from '@/components/body-editor-adapter';
import { ConnectionsAdapter } from '@/components/connections-adapter';
import {
  defaultConnectionsPresentation,
  type ConnectionsPresentationAdapter,
} from '@/components/connections-presentation';
import { ConnectionsView } from '@/components/connections-view';
import { NotesPresentation } from '@/components/notes-presentation';
import type {
  CardEditorRendererProps,
  ConnectionsRendererProps,
  NotesPresentationComponent,
  NotesPresentationFeatures,
} from '@/components/presentation-contract';
import type { NotesRuntimePorts } from '@/lib/application/notes-runtime';
import { createLegacyNotesRuntimePorts } from '@/lib/client/legacy-notes-runtime';
import { NotesProvider, useNotesDataStore } from '@/lib/client/notes-store';
import { useNotesApplication } from '@/lib/client/use-notes-application';
import type { CardEditorPresentationAdapter } from '@/lib/editor/use-card-editor';

export type NotesAppConfiguration = {
  Presentation: NotesPresentationComponent;
  CardEditorRenderer: ComponentType<CardEditorRendererProps>;
  cardEditorPresentation: CardEditorPresentationAdapter;
  ConnectionsRenderer: ComponentType<ConnectionsRendererProps>;
  connectionsPresentation: ConnectionsPresentationAdapter;
};

export const defaultNotesAppConfiguration: NotesAppConfiguration = {
  Presentation: NotesPresentation,
  CardEditorRenderer: BodyEditor,
  cardEditorPresentation: defaultCardEditorPresentation,
  ConnectionsRenderer: ConnectionsView,
  connectionsPresentation: defaultConnectionsPresentation,
};

function NotesConnector({
  configuration,
}: {
  configuration: NotesAppConfiguration;
}) {
  const store = useNotesDataStore();
  const { model, actions } = useNotesApplication(store);
  const features = useMemo<NotesPresentationFeatures>(
    () => ({
      renderCardEditor: ({ input, actions: editorActions }) => (
        <BodyEditorAdapter
          model={input}
          actions={editorActions}
          presentation={configuration.cardEditorPresentation}
          Renderer={configuration.CardEditorRenderer}
        />
      ),
      renderConnections: ({ input, actions: connectionsActions }) => (
        <ConnectionsAdapter
          input={input}
          actions={connectionsActions}
          presentation={configuration.connectionsPresentation}
          Renderer={configuration.ConnectionsRenderer}
        />
      ),
    }),
    [configuration],
  );
  const Presentation = configuration.Presentation;
  return <Presentation model={model} actions={actions} features={features} />;
}

export function NotesApp({
  configuration = defaultNotesAppConfiguration,
  runtimePorts,
}: {
  configuration?: NotesAppConfiguration;
  runtimePorts?: NotesRuntimePorts;
}) {
  const [legacyRuntimePorts] = useState(createLegacyNotesRuntimePorts);
  return (
    <NotesProvider ports={runtimePorts ?? legacyRuntimePorts}>
      <NotesConnector configuration={configuration} />
    </NotesProvider>
  );
}
