import type { DirectedEdge } from '@/lib/domain/graph';
import type { CardId } from '@/lib/domain/id';
import type {
  ConnectionsLayout,
  ConnectionsLayoutEdge,
  ConnectionsLayoutNode,
} from '@/lib/graph/elk-layout';

export type ConnectionsSemanticNode = {
  cardId: CardId;
  displayLabel: string;
  title: string;
  accessibleName: string;
  current: boolean;
};

export type ConnectionsSemanticEdge = DirectedEdge & {
  accessibleName: string;
};

export type ConnectionsInputModel = {
  currentCardId: CardId;
  nodes: ConnectionsSemanticNode[];
  edges: ConnectionsSemanticEdge[];
};

export type ConnectionsSelectionActions = {
  openCard: (cardId: CardId) => void;
};

type ConnectionsStateBase = {
  layoutKey: string;
  currentCardId: CardId;
  fallbackItems: ConnectionsSemanticNode[];
};

export type ConnectionsLoadingState = ConnectionsStateBase & {
  status: 'loading';
};

export type ConnectionsErrorState = ConnectionsStateBase & {
  status: 'error';
};

export type ConnectionsReadyNode = ConnectionsSemanticNode &
  Omit<ConnectionsLayoutNode, 'id'>;

export type ConnectionsReadyEdge = ConnectionsSemanticEdge &
  Omit<ConnectionsLayoutEdge, 'sourceCardId' | 'targetCardId'>;

export type ConnectionsReadyState = ConnectionsStateBase & {
  status: 'ready';
  geometry: ConnectionsLayout;
  width: number;
  height: number;
  nodes: ConnectionsReadyNode[];
  edges: ConnectionsReadyEdge[];
  currentNode: ConnectionsReadyNode | null;
};

export type ConnectionsControllerState =
  | ConnectionsLoadingState
  | ConnectionsErrorState
  | ConnectionsReadyState;
