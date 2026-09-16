import type { DirectedEdge } from '@/lib/domain/graph';
import type { CardId } from '@/lib/domain/id';

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
