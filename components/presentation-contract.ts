import type { ComponentType, ReactNode } from 'react';
import type { ConnectionsPresentationAdapter } from '@/components/connections-presentation';
import type {
  ConnectionsViewModel,
  NotesPresentationActions,
  NotesPresentationModel,
} from '@/lib/application/presentation';
import type { NotesViewStatePorts } from '@/lib/application/notes-view-state';
import type {
  CardEditorCommands,
  CardEditorModel,
} from '@/lib/editor/use-card-editor';
import type {
  ConnectionsControllerState,
  ConnectionsSelectionActions,
} from '@/lib/graph/connections-contract';

export type CardEditorRendererProps = {
  model: CardEditorModel;
  commands: CardEditorCommands;
};

export type ConnectionsRendererProps = {
  model: ConnectionsControllerState;
  totalNodeCount: number;
  totalEdgeCount: number;
  actions: ConnectionsSelectionActions;
  presentation: ConnectionsPresentationAdapter;
  cameraPosition: NotesViewStatePorts['connections'];
};

export type ConnectionsFeatureProps = {
  input: ConnectionsViewModel;
  actions: Pick<NotesPresentationActions, 'openCard'>;
};

export type NotesPresentationFeatures = {
  renderCardEditor: () => ReactNode;
  renderConnections: (props: ConnectionsFeatureProps) => ReactNode;
  viewState: Pick<NotesViewStatePorts, 'body' | 'history'>;
};

export type NotesPresentationProps = {
  model: NotesPresentationModel;
  actions: NotesPresentationActions;
  features: NotesPresentationFeatures;
};

export type NotesPresentationComponent = ComponentType<NotesPresentationProps>;
