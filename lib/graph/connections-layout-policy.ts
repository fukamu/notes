export type ConnectionsLayoutStrategy = 'elk' | 'corridor';

export const CONNECTIONS_ELK_MAXIMUM_NODE_COUNT = 256;
export const CONNECTIONS_ELK_MAXIMUM_EDGE_COUNT = 1_024;
export const CONNECTIONS_ELK_INITIAL_DEADLINE_MS = 2_000;

export const DEFAULT_CONNECTIONS_CORRIDOR_OPTIONS = {
  laneSpacing: 8,
} as const;

/**
 * Bump this revision whenever a decision that can change layout geometry or
 * engine selection changes. The layout cache key includes this value.
 */
export const CONNECTIONS_LAYOUT_POLICY_REVISION =
  'hybrid-corridor-v1-n256-e1024-lane8-ar16x9-cost005';

function requireCount(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

export function chooseConnectionsLayoutEngine(
  nodeCount: number,
  edgeCount: number,
): ConnectionsLayoutStrategy {
  requireCount(nodeCount, 'Connections layout node count');
  requireCount(edgeCount, 'Connections layout edge count');
  return nodeCount <= CONNECTIONS_ELK_MAXIMUM_NODE_COUNT &&
    edgeCount <= CONNECTIONS_ELK_MAXIMUM_EDGE_COUNT
    ? 'elk'
    : 'corridor';
}
