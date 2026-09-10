import { outgoingCardIds } from './body';
import { invariant } from '@/lib/shared/invariant';
import type { CardRecord } from './types';

export type ConnectionsNode = {
  card: CardRecord;
};

export type DirectedEdge = {
  sourceCardId: string;
  targetCardId: string;
};

export type ConnectionsGraph = {
  nodes: ConnectionsNode[];
  edges: DirectedEdge[];
};

function compareGraphCards(left: CardRecord, right: CardRecord): number {
  return (
    left.displayId.value - right.displayId.value ||
    left.id.localeCompare(right.id)
  );
}

/**
 * Builds the displayed graph exclusively from each local card's explicit
 * outgoing links. currentCardId deliberately is not an input: the current
 * card affects presentation and initial focus, never graph membership.
 */
export function buildConnectionsGraph(cards: CardRecord[]): ConnectionsGraph {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const sortedCards = [...byId.values()].sort(compareGraphCards);
  const cardOrder = new Map(sortedCards.map((card, index) => [card.id, index]));
  const edges: DirectedEdge[] = [];

  for (const source of sortedCards) {
    const targetIds = new Set(
      outgoingCardIds(source.body).filter((targetCardId) =>
        byId.has(targetCardId),
      ),
    );
    const sortedTargetIds = [...targetIds].sort((left, right) => {
      const leftOrder = cardOrder.get(left);
      const rightOrder = cardOrder.get(right);
      invariant(leftOrder, `Missing graph order for card ${left}`);
      invariant(rightOrder, `Missing graph order for card ${right}`);
      return leftOrder - rightOrder;
    });
    for (const targetCardId of sortedTargetIds) {
      edges.push({ sourceCardId: source.id, targetCardId });
    }
  }

  return {
    nodes: sortedCards.map((card) => ({ card })),
    edges,
  };
}
