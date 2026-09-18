import type {
  ConnectionsControllerState,
  ConnectionsInputModel,
  ConnectionsReadyEdge,
  ConnectionsReadyNode,
} from '@/lib/graph/connections-contract';
import {
  type ConnectionsLayout,
  type ConnectionsLayoutGraph,
  type ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';
import { connectionsSemanticLayoutKey } from '@/lib/graph/connections-layout-key';
import { invariant } from '@/lib/shared/invariant';

export type ConnectionsLayoutRunner = (
  graph: ConnectionsLayoutGraph,
  metrics: ConnectionsLayoutMetrics,
) => Promise<ConnectionsLayout>;

export type ConnectionsController = {
  getState: () => ConnectionsControllerState;
  subscribe: (listener: () => void) => () => void;
  update: (
    input: ConnectionsInputModel,
    metrics: ConnectionsLayoutMetrics,
  ) => void;
  destroy: () => void;
};

type SettledLayout =
  | { key: string; status: 'ready'; layout: ConnectionsLayout }
  | { key: string; status: 'error' };

function layoutGraph(input: ConnectionsInputModel): ConnectionsLayoutGraph {
  return {
    nodes: input.nodes.map((node) => ({ id: node.cardId })),
    edges: input.edges.map(({ sourceCardId, targetCardId }) => ({
      sourceCardId,
      targetCardId,
    })),
  };
}

export function connectionsLayoutKey(
  input: ConnectionsInputModel,
  metrics: ConnectionsLayoutMetrics,
): string {
  return connectionsSemanticLayoutKey(input, metrics);
}

function loadingState(
  input: ConnectionsInputModel,
  layoutKey: string,
): ConnectionsControllerState {
  return {
    status: 'loading',
    layoutKey,
    currentCardId: input.currentCardId,
    fallbackItems: input.nodes,
  };
}

function errorState(
  input: ConnectionsInputModel,
  layoutKey: string,
): ConnectionsControllerState {
  return {
    status: 'error',
    layoutKey,
    currentCardId: input.currentCardId,
    fallbackItems: input.nodes,
  };
}

function readyState(
  input: ConnectionsInputModel,
  layoutKey: string,
  layout: ConnectionsLayout,
): ConnectionsControllerState {
  const semanticNodes = new Map(input.nodes.map((node) => [node.cardId, node]));
  const semanticEdges = input.edges;
  const nodes = layout.nodes.map((node): ConnectionsReadyNode => {
    const semantic = semanticNodes.get(node.id);
    invariant(semantic, `Missing semantic connections node ${node.id}`);
    const { id: _id, ...geometry } = node;
    return { ...semantic, ...geometry };
  });
  const edges = layout.edges.map((edge, index): ConnectionsReadyEdge => {
    const semantic = semanticEdges[index];
    invariant(semantic, `Missing semantic connections edge ${edge.id}`);
    invariant(
      semantic.sourceCardId === edge.sourceCardId &&
        semantic.targetCardId === edge.targetCardId,
      `Connections edge order changed for ${edge.id}`,
    );
    const { sourceCardId: _source, targetCardId: _target, ...geometry } = edge;
    return { ...semantic, ...geometry };
  });
  return {
    status: 'ready',
    layoutKey,
    currentCardId: input.currentCardId,
    fallbackItems: input.nodes,
    geometry: layout,
    width: layout.width,
    height: layout.height,
    nodes,
    edges,
    currentNode:
      nodes.find((node) => node.cardId === input.currentCardId) ?? null,
  };
}

export function createConnectionsController(
  initialInput: ConnectionsInputModel,
  initialMetrics: ConnectionsLayoutMetrics,
  runner: ConnectionsLayoutRunner,
): ConnectionsController {
  let state: ConnectionsControllerState = loadingState(
    initialInput,
    connectionsLayoutKey(initialInput, initialMetrics),
  );
  let latestInput: ConnectionsInputModel | null = initialInput;
  let activeKey: string | null = null;
  let requestVersion = 0;
  let settled: SettledLayout | null = null;
  const listeners = new Set<() => void>();

  const emit = () => {
    for (const listener of listeners) listener();
  };

  const update = (
    input: ConnectionsInputModel,
    metrics: ConnectionsLayoutMetrics,
  ) => {
    latestInput = input;
    const key = connectionsLayoutKey(input, metrics);

    if (settled?.key === key) {
      if (activeKey !== null && activeKey !== key) {
        requestVersion += 1;
        activeKey = null;
      }
      state =
        settled.status === 'ready'
          ? readyState(input, key, settled.layout)
          : errorState(input, key);
      emit();
      return;
    }
    if (activeKey === key) {
      state = loadingState(input, key);
      emit();
      return;
    }

    activeKey = key;
    const request = ++requestVersion;
    state = loadingState(input, key);
    emit();
    void runner(layoutGraph(input), metrics)
      .then((layout) => {
        if (request !== requestVersion || activeKey !== key || !latestInput)
          return;
        settled = { key, status: 'ready', layout };
        activeKey = null;
        state = readyState(latestInput, key, layout);
        emit();
      })
      .catch(() => {
        if (request !== requestVersion || activeKey !== key || !latestInput)
          return;
        settled = { key, status: 'error' };
        activeKey = null;
        state = errorState(latestInput, key);
        emit();
      });
  };

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    update,
    destroy: () => {
      requestVersion += 1;
      activeKey = null;
      latestInput = null;
    },
  };
}
