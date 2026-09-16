import type { CardId } from '@/lib/domain/id';
import type {
  ConnectionsInputModel,
  ConnectionsSemanticNode,
} from '@/lib/graph/connections-contract';

export type ConnectionsStagingPolicy = Readonly<{
  initialNodeLimit: number;
  expansionPageSize: number;
  maximumNodeLimit: number;
}>;

export const defaultConnectionsStagingPolicy = {
  initialNodeLimit: 64,
  expansionPageSize: 64,
  maximumNodeLimit: 256,
} as const satisfies ConnectionsStagingPolicy;

export type ConnectionsStageRequest = Readonly<{
  expansionPage: number;
}>;

export type ConnectionsStageSelection = Readonly<{
  input: ConnectionsInputModel;
  focusCardId: CardId | null;
  totalNodeCount: number;
  visibleNodeCount: number;
  nodeLimit: number;
  hiddenReachableNodeCount: number;
  canExpand: boolean;
  stoppedAtMaximum: boolean;
}>;

function requirePositiveInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive integer`);
  }
}

function validatePolicy(policy: ConnectionsStagingPolicy): void {
  requirePositiveInteger(policy.initialNodeLimit, 'initialNodeLimit');
  requirePositiveInteger(policy.expansionPageSize, 'expansionPageSize');
  requirePositiveInteger(policy.maximumNodeLimit, 'maximumNodeLimit');
  if (policy.initialNodeLimit > policy.maximumNodeLimit) {
    throw new RangeError('initialNodeLimit must not exceed maximumNodeLimit');
  }
}

function expansionPage(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? value : 0;
}

function nodeLimit(
  requestedPage: number,
  policy: ConnectionsStagingPolicy,
): number {
  const additional = expansionPage(requestedPage) * policy.expansionPageSize;
  return Math.min(
    policy.maximumNodeLimit,
    policy.initialNodeLimit + additional,
  );
}

function uniqueNodes(
  nodes: readonly ConnectionsSemanticNode[],
): ConnectionsSemanticNode[] {
  const seen = new Set<CardId>();
  const unique: ConnectionsSemanticNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.cardId)) continue;
    seen.add(node.cardId);
    unique.push(node);
  }
  return unique;
}

function resolveFocusCardId(
  input: ConnectionsInputModel,
  nodesById: ReadonlyMap<CardId, ConnectionsSemanticNode>,
  nodes: readonly ConnectionsSemanticNode[],
): CardId | null {
  if (nodesById.has(input.currentCardId)) return input.currentCardId;
  return nodes[0]?.cardId ?? null;
}

function neighborhoodOrder(
  input: ConnectionsInputModel,
  nodes: readonly ConnectionsSemanticNode[],
  nodesById: ReadonlyMap<CardId, ConnectionsSemanticNode>,
  focusCardId: CardId,
): CardId[] {
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
  return queue;
}

export function selectConnectionsStage(
  input: ConnectionsInputModel,
  request: ConnectionsStageRequest,
  policy: ConnectionsStagingPolicy = defaultConnectionsStagingPolicy,
): ConnectionsStageSelection {
  validatePolicy(policy);
  const nodes = uniqueNodes(input.nodes);
  const nodesById = new Map(nodes.map((node) => [node.cardId, node]));
  const focusCardId = resolveFocusCardId(input, nodesById, nodes);
  const requestedNodeLimit = nodeLimit(request.expansionPage, policy);

  if (nodes.length <= policy.initialNodeLimit || focusCardId === null) {
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
      focusCardId,
      totalNodeCount: nodes.length,
      visibleNodeCount: nodes.length,
      nodeLimit: requestedNodeLimit,
      hiddenReachableNodeCount: 0,
      canExpand: false,
      stoppedAtMaximum: false,
    };
  }

  const reachable = neighborhoodOrder(input, nodes, nodesById, focusCardId);
  const visibleIds = new Set(reachable.slice(0, requestedNodeLimit));
  const visibleNodes = nodes.filter((node) => visibleIds.has(node.cardId));
  const hiddenReachableNodeCount = reachable.length - visibleNodes.length;
  const stoppedAtMaximum =
    hiddenReachableNodeCount > 0 &&
    requestedNodeLimit === policy.maximumNodeLimit;

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
    focusCardId,
    totalNodeCount: nodes.length,
    visibleNodeCount: visibleNodes.length,
    nodeLimit: requestedNodeLimit,
    hiddenReachableNodeCount,
    canExpand: hiddenReachableNodeCount > 0 && !stoppedAtMaximum,
    stoppedAtMaximum,
  };
}

export function nextConnectionsExpansionPage(
  currentPage: number,
  policy: ConnectionsStagingPolicy = defaultConnectionsStagingPolicy,
): number {
  validatePolicy(policy);
  const maximumPage = Math.ceil(
    (policy.maximumNodeLimit - policy.initialNodeLimit) /
      policy.expansionPageSize,
  );
  return Math.min(expansionPage(currentPage) + 1, maximumPage);
}
