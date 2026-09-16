'use client';

import { useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
import {
  BodyEditor,
  defaultCardEditorPresentation,
} from '@/components/body-editor';
import { BodyEditorAdapter } from '@/components/body-editor-adapter';
import { ConnectionsAdapter } from '@/components/connections-adapter';
import { ConnectionsView } from '@/components/connections-view';
import { NotesPresentation } from '@/components/notes-presentation';
import type {
  CardEditorRendererProps,
  ConnectionsRendererProps,
  NotesPresentationComponent,
  NotesPresentationFeatures,
} from '@/components/presentation-contract';
import type { NotesRuntimePorts } from '@/lib/application/notes-runtime';
import { createFullNetworkMapSession } from '@/lib/application/full-network-map-session';
import { createLegacyNotesRuntimePorts } from '@/lib/client/legacy-notes-runtime';
import { NotesProvider, useNotesDataStore } from '@/lib/client/notes-store';
import { useNotesApplication } from '@/lib/client/use-notes-application';
import type { CardEditorPresentationAdapter } from '@/lib/editor/use-card-editor';

export type NotesAppConfiguration = {
  Presentation: NotesPresentationComponent;
  CardEditorRenderer: ComponentType<CardEditorRendererProps>;
  cardEditorPresentation: CardEditorPresentationAdapter;
  ConnectionsRenderer: ComponentType<ConnectionsRendererProps>;
};

export const defaultNotesAppConfiguration: NotesAppConfiguration = {
  Presentation: NotesPresentation,
  CardEditorRenderer: BodyEditor,
  cardEditorPresentation: defaultCardEditorPresentation,
  ConnectionsRenderer: ConnectionsView,
};

function NotesConnector({
  configuration,
  runtimePorts,
  mapSession,
}: {
  configuration: NotesAppConfiguration;
  runtimePorts: NotesRuntimePorts;
  mapSession: ReturnType<typeof createFullNetworkMapSession>;
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
          scope={runtimePorts.scope}
          session={mapSession}
          Renderer={configuration.ConnectionsRenderer}
        />
      ),
    }),
    [configuration, mapSession, runtimePorts.scope],
  );
  const Presentation = configuration.Presentation;
  return <Presentation model={model} actions={actions} features={features} />;
}

export function NotesApp({
  configuration = defaultNotesAppConfiguration,
  runtimePorts,
  runtimeFenced = false,
  runtimeFencedFallback,
}: {
  configuration?: NotesAppConfiguration;
  runtimePorts: NotesRuntimePorts;
  runtimeFenced?: boolean;
  runtimeFencedFallback?: ReactNode;
}) {
  const mapSession = useMemo(
    () => createFullNetworkMapSession(runtimePorts.scope),
    [runtimePorts.scope],
  );
  return (
    <NotesProvider
      ports={runtimePorts}
      fenced={runtimeFenced}
      fencedFallback={runtimeFencedFallback}
    >
      <NotesConnector
        configuration={configuration}
        runtimePorts={runtimePorts}
        mapSession={mapSession}
      />
    </NotesProvider>
  );
}

/** Explicit compatibility harness until the authenticated route is composed. */
export function LegacyNotesApp({
  configuration = defaultNotesAppConfiguration,
}: {
  configuration?: NotesAppConfiguration;
}) {
  const [legacyRuntimePorts] = useState(createLegacyNotesRuntimePorts);
  return (
    <NotesApp configuration={configuration} runtimePorts={legacyRuntimePorts} />
  );
}
