import type { CardId } from '@/lib/domain/id';
import type {
  ConnectionsInputModel,
  ConnectionsSemanticNode,
} from '@/lib/graph/connections-contract';

// This benchmark-only snapshot preserves the phase-0 A baseline after the
// production 64-card staging implementation was removed. It must never be
// imported by product code or used as a current product capability.
export function selectLegacyInitialConnectionsStage(
  input: ConnectionsInputModel,
) {
  const seen = new Set<CardId>();
  const nodes: ConnectionsSemanticNode[] = [];
  for (const node of input.nodes) {
    if (seen.has(node.cardId)) continue;
    seen.add(node.cardId);
    nodes.push(node);
  }
  const nodesById = new Map(nodes.map((node) => [node.cardId, node]));
  const focusCardId = nodesById.has(input.currentCardId)
    ? input.currentCardId
    : (nodes[0]?.cardId ?? null);
  if (nodes.length <= 64 || focusCardId === null) {
    const visibleIds = new Set(nodes.map((node) => node.cardId));
    return {
      input: {
        currentCardId: input.currentCardId,
        nodes,
        edges: input.edges.filter(
          (edge) =>
            visibleIds.has(edge.sourceCardId) &&
            visibleIds.has(edge.targetCardId),
        ),
      },
      hiddenReachableNodeCount: 0,
      stoppedAtMaximum: false,
    };
  }
  const order = new Map(nodes.map((node, index) => [node.cardId, index]));
  const adjacent = new Map(
    nodes.map((node) => [node.cardId, new Set<CardId>()]),
  );
  for (const edge of input.edges) {
    if (
      !nodesById.has(edge.sourceCardId) ||
      !nodesById.has(edge.targetCardId)
    ) {
      continue;
    }
    adjacent.get(edge.sourceCardId)?.add(edge.targetCardId);
    adjacent.get(edge.targetCardId)?.add(edge.sourceCardId);
  }
  const queue: CardId[] = [focusCardId];
  const visited = new Set(queue);
  for (let position = 0; position < queue.length; position += 1) {
    const cardId = queue[position];
    if (!cardId) continue;
    const neighbors = [...(adjacent.get(cardId) ?? [])].sort(
      (left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0),
    );
    for (const neighbor of neighbors) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      queue.push(neighbor);
    }
  }
  const visibleIds = new Set(queue.slice(0, 64));
  const visibleNodes = nodes.filter((node) => visibleIds.has(node.cardId));
  return {
    input: {
      currentCardId: input.currentCardId,
      nodes: visibleNodes,
      edges: input.edges.filter(
        (edge) =>
          visibleIds.has(edge.sourceCardId) &&
          visibleIds.has(edge.targetCardId),
      ),
    },
    hiddenReachableNodeCount: queue.length - visibleNodes.length,
    stoppedAtMaximum: false,
  };
}
