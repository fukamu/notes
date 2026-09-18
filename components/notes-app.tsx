'use client';

import { useEffect, useMemo, useState } from 'react';
import type { ComponentType, ReactNode } from 'react';
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
import type {
  CardEditorActivity,
  CardEditorDocumentInput,
  NotesPresentationActions,
} from '@/lib/application/presentation';
import type { CardEdit } from '@/lib/domain/card-transitions';
import type { CardId } from '@/lib/domain/id';
import { createNotesViewStatePorts } from '@/lib/client/notes-view-state';
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

type EditorSessionLifetime = {
  start: () => void;
  stop: () => void;
  isActive: () => boolean;
};

function createEditorSessionLifetime(): EditorSessionLifetime {
  let active = true;
  return {
    start: () => {
      active = true;
    },
    stop: () => {
      active = false;
    },
    isActive: () => active,
  };
}

function CardEditorSession({
  document,
  activity,
  openCard,
  updateCard,
  configuration,
}: {
  document: CardEditorDocumentInput;
  activity: CardEditorActivity;
  openCard: NotesPresentationActions['openCard'];
  updateCard: (cardId: CardId, edit: CardEdit) => void;
  configuration: NotesAppConfiguration;
}) {
  const [lifetime] = useState(createEditorSessionLifetime);
  useEffect(() => {
    lifetime.start();
    return lifetime.stop;
  }, [lifetime]);
  const sessionCardId = document.cardId;
  const editorActions = useMemo(
    () => ({
      openCard: (cardId: CardId) => {
        if (lifetime.isActive()) openCard(cardId);
      },
      updateTitle: (title: string) => {
        if (lifetime.isActive()) {
          updateCard(sessionCardId, { type: 'title', title });
        }
      },
      updateBody: (
        body: Parameters<NotesPresentationActions['updateBody']>[0],
      ) => {
        if (lifetime.isActive()) {
          updateCard(sessionCardId, { type: 'body', body });
        }
      },
    }),
    [lifetime, openCard, sessionCardId, updateCard],
  );
  return (
    <BodyEditorAdapter
      document={document}
      activity={activity}
      actions={editorActions}
      presentation={configuration.cardEditorPresentation}
      Renderer={configuration.CardEditorRenderer}
    />
  );
}

function NotesConnector({
  configuration,
}: {
  configuration: NotesAppConfiguration;
}) {
  const store = useNotesDataStore();
  const { model, actions } = useNotesApplication(store);
  const currentCardId = model.currentCard?.id ?? null;
  const viewState = useMemo(
    () => createNotesViewStatePorts(currentCardId),
    [currentCardId],
  );
  const [editorSessionCardId, setEditorSessionCardId] = useState(() =>
    model.activeView === 'card' ? currentCardId : null,
  );
  const validEditorSessionCardId =
    editorSessionCardId === currentCardId ? editorSessionCardId : null;

  useEffect(() => {
    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setEditorSessionCardId((current) => {
        if (currentCardId === null) return null;
        if (current === currentCardId) return current;
        return model.activeView === 'card' ? currentCardId : null;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [currentCardId, model.activeView]);

  const editorDocument = useMemo<CardEditorDocumentInput | null>(() => {
    if (
      validEditorSessionCardId === null ||
      model.currentCard?.id !== validEditorSessionCardId
    ) {
      return null;
    }
    return {
      cardId: model.currentCard.id,
      title: model.currentCard.title,
      body: model.currentCard.body,
    };
  }, [model.currentCard, validEditorSessionCardId]);
  const editorActivity = useMemo<CardEditorActivity>(() => {
    if (
      model.activeView === 'card' &&
      model.cardEditor?.cardId === validEditorSessionCardId
    ) {
      return {
        kind: 'active',
        labels: model.cardEditor.labels,
        candidateIndex: model.cardEditor.candidateIndex,
      };
    }
    return { kind: 'inactive' };
  }, [model.activeView, model.cardEditor, validEditorSessionCardId]);
  const editorFeature = useMemo(
    () =>
      editorDocument ? (
        <CardEditorSession
          key={editorDocument.cardId}
          document={editorDocument}
          activity={editorActivity}
          openCard={actions.openCard}
          updateCard={store.updateCard}
          configuration={configuration}
        />
      ) : null,
    [
      actions.openCard,
      configuration,
      editorActivity,
      editorDocument,
      store.updateCard,
    ],
  );
  const features = useMemo<NotesPresentationFeatures>(
    () => ({
      renderCardEditor: () => editorFeature,
      renderConnections: ({ input, actions: connectionsActions }) => (
        <ConnectionsAdapter
          input={input}
          actions={connectionsActions}
          presentation={configuration.connectionsPresentation}
          Renderer={configuration.ConnectionsRenderer}
          cameraPosition={viewState.connections}
        />
      ),
      viewState: {
        body: viewState.body,
        history: viewState.history,
      },
    }),
    [configuration, editorFeature, viewState],
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
  return (
    <NotesProvider
      ports={runtimePorts}
      fenced={runtimeFenced}
      fencedFallback={runtimeFencedFallback}
    >
      <NotesConnector configuration={configuration} />
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
