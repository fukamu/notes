import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import { CONNECTIONS_LAYOUT_POLICY_REVISION } from '@/lib/graph/connections-layout-policy';
import type {
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';

export function connectionsLayoutGraphKey(
  graph: ConnectionsLayoutGraph,
  metrics: ConnectionsLayoutMetrics,
): string {
  return JSON.stringify({
    policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
    nodes: graph.nodes.map((node) => node.id),
    edges: graph.edges.map(({ sourceCardId, targetCardId }) => [
      sourceCardId,
      targetCardId,
    ]),
    metrics,
  });
}

export function connectionsSemanticLayoutKey(
  input: ConnectionsInputModel,
  metrics: ConnectionsLayoutMetrics,
): string {
  return connectionsLayoutGraphKey(
    {
      nodes: input.nodes.map((node) => ({ id: node.cardId })),
      edges: input.edges.map(({ sourceCardId, targetCardId }) => ({
        sourceCardId,
        targetCardId,
      })),
    },
    metrics,
  );
}
