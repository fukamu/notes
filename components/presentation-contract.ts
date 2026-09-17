import type { ComponentType, ReactNode } from 'react';
import type { ConnectionsPresentationAdapter } from '@/components/connections-presentation';
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
import type {
  ConnectionsControllerState,
  ConnectionsInputModel,
  ConnectionsSelectionActions,
} from '@/lib/graph/connections-contract';

export type CardEditorRendererProps = {
  model: CardEditorModel;
  commands: CardEditorCommands;
};

export type ConnectionsRendererProps = {
  model: ConnectionsControllerState;
  semanticInput: ConnectionsInputModel;
  totalNodeCount: number;
  totalEdgeCount: number;
  actions: ConnectionsSelectionActions;
  presentation: ConnectionsPresentationAdapter;
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
