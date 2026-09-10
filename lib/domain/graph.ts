import { outgoingCardIds } from './body';
import type { CardRecord } from './types';

export type ReachableNode = {
  card: CardRecord;
  depth: number;
};

export type DirectedEdge = {
  sourceCardId: string;
  targetCardId: string;
};

export type ReachableGraph = {
  nodes: ReachableNode[];
  edges: DirectedEdge[];
};

export function buildReachableGraph(cards: CardRecord[], rootCardId: string): ReachableGraph {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const root = byId.get(rootCardId);
  if (!root) return { nodes: [], edges: [] };

  const depths = new Map<string, number>([[root.id, 0]]);
  const queue = [root.id];
  const edges: DirectedEdge[] = [];
  const edgeKeys = new Set<string>();

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const sourceId = queue[cursor];
    const source = byId.get(sourceId)!;
    const depth = depths.get(sourceId)!;

    for (const targetId of outgoingCardIds(source.body)) {
      if (!byId.has(targetId)) continue;
      const edgeKey = `${sourceId}\u0000${targetId}`;
      if (!edgeKeys.has(edgeKey)) {
        edgeKeys.add(edgeKey);
        edges.push({ sourceCardId: sourceId, targetCardId: targetId });
      }
      if (!depths.has(targetId)) {
        depths.set(targetId, depth + 1);
        queue.push(targetId);
      }
    }
  }

  return {
    nodes: queue.map((cardId) => ({ card: byId.get(cardId)!, depth: depths.get(cardId)! })),
    edges,
  };
}
