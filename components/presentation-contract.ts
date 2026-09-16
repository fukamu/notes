import type { ComponentType, ReactNode } from 'react';
import type { FullNetworkLayoutControllerState } from '@/lib/application/full-network-layout-controller';
import type { FullNetworkMapSession } from '@/lib/application/full-network-map-session';
import type { NotesScope } from '@/lib/application/notes-runtime';
import type {
  CardEditorInputModel,
  ConnectionsViewModel,
  NotesPresentationActions,
  NotesPresentationModel,
} from '@/lib/application/presentation';
import type {
  CardEditorCommands,
  CardEditorModel,
} from '@/lib/editor/use-card-editor';
import type { ConnectionsSelectionActions } from '@/lib/graph/connections-contract';

export type CardEditorRendererProps = {
  model: CardEditorModel;
  commands: CardEditorCommands;
};

export type ConnectionsRendererProps = {
  state: FullNetworkLayoutControllerState;
  actions: Pick<ConnectionsSelectionActions, 'openCard'>;
  scope: NotesScope;
  session: FullNetworkMapSession;
  retryLayout: () => void;
};

export type CardEditorFeatureProps = {
  input: CardEditorInputModel;
  actions: Pick<NotesPresentationActions, 'openCard' | 'updateBody'>;
};

export type ConnectionsFeatureProps = {
  input: ConnectionsViewModel;
  actions: Pick<NotesPresentationActions, 'openCard'>;
};

export type NotesPresentationFeatures = {
  renderCardEditor: (props: CardEditorFeatureProps) => ReactNode;
  renderConnections: (props: ConnectionsFeatureProps) => ReactNode;
};

export type NotesPresentationProps = {
  model: NotesPresentationModel;
  actions: NotesPresentationActions;
  features: NotesPresentationFeatures;
};

export type NotesPresentationComponent = ComponentType<NotesPresentationProps>;
