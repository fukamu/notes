import { describe, expect, it } from 'vitest';
import {
  decodeConnectionsCorridorLayout,
  decodeConnectionsCorridorWorkerRequest,
  decodeConnectionsCorridorWorkerResponse,
} from '@/lib/client/connections-corridor-worker-protocol';
import { layoutConnectionsCorridors } from '@/lib/graph/connections-corridor-layout';
import {
  CONNECTIONS_LAYOUT_POLICY_REVISION,
  DEFAULT_CONNECTIONS_CORRIDOR_OPTIONS,
} from '@/lib/graph/connections-layout-policy';
import type {
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';
import { fixtureCardId } from '@/tests/fixtures/ids';

const firstId = fixtureCardId('corridor-protocol-first');
const secondId = fixtureCardId('corridor-protocol-second');
const graph: ConnectionsLayoutGraph = {
  nodes: [{ id: firstId }, { id: secondId }],
  edges: [
    { sourceCardId: firstId, targetCardId: secondId },
    { sourceCardId: secondId, targetCardId: firstId },
  ],
};
const metrics: ConnectionsLayoutMetrics = {
  nodeWidth: 196,
  nodeHeight: 72,
  portSize: 2,
  componentSpacing: 96,
  nodeSpacing: 72,
  edgeNodeSpacing: 32,
  layerSpacing: 112,
  edgeLayerSpacing: 40,
  padding: { top: 24, right: 24, bottom: 24, left: 24 },
};

function request() {
  return {
    type: 'layout',
    requestId: 7,
    generation: 3,
    policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
    graph,
    metrics,
    options: DEFAULT_CONNECTIONS_CORRIDOR_OPTIONS,
  } as const;
}

describe('connections corridor Worker protocol', () => {
  it('decodes the complete request and response without changing identity', () => {
    const decodedRequest = decodeConnectionsCorridorWorkerRequest(request());
    expect(decodedRequest).toEqual(request());
    const layout = layoutConnectionsCorridors(
      decodedRequest.graph,
      decodedRequest.metrics,
      decodedRequest.options,
    );
    const response = decodeConnectionsCorridorWorkerResponse({
      type: 'completed',
      requestId: decodedRequest.requestId,
      generation: decodedRequest.generation,
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
      workerLayoutMs: 12.5,
      layout,
    });
    expect(response).toMatchObject({
      type: 'completed',
      requestId: 7,
      generation: 3,
    });
    if (response.type !== 'completed') return;
    expect(
      decodeConnectionsCorridorLayout(response.layout, graph, metrics),
    ).toEqual(layout);
  });

  it('rejects incompatible policy, missing endpoints, and malformed metrics', () => {
    expect(() =>
      decodeConnectionsCorridorWorkerRequest({
        ...request(),
        policyRevision: 'old-policy',
      }),
    ).toThrow('policy revision is incompatible');
    expect(() =>
      decodeConnectionsCorridorWorkerRequest({
        ...request(),
        graph: {
          nodes: graph.nodes.slice(0, 1),
          edges: graph.edges,
        },
      }),
    ).toThrow('missing endpoint');
    expect(() =>
      decodeConnectionsCorridorWorkerRequest({
        ...request(),
        metrics: { ...metrics, nodeWidth: Number.NaN },
      }),
    ).toThrow('nodeWidth must be finite');
  });

  it('rejects changed order, non-finite points, and incorrect port ownership', () => {
    const layout = layoutConnectionsCorridors(graph, metrics, {
      laneSpacing: 8,
    });
    expect(() =>
      decodeConnectionsCorridorLayout(
        { ...layout, nodes: [...layout.nodes].reverse() },
        graph,
        metrics,
      ),
    ).toThrow('changed node order');

    const firstEdge = layout.edges[0];
    expect(firstEdge).toBeDefined();
    if (!firstEdge) return;
    const firstSection = firstEdge.sections[0];
    expect(firstSection).toBeDefined();
    if (!firstSection) return;
    expect(() =>
      decodeConnectionsCorridorLayout(
        {
          ...layout,
          edges: [
            {
              ...firstEdge,
              sections: [
                {
                  ...firstSection,
                  endPoint: {
                    ...firstSection.endPoint,
                    x: Number.POSITIVE_INFINITY,
                  },
                },
              ],
            },
            ...layout.edges.slice(1),
          ],
        },
        graph,
        metrics,
      ),
    ).toThrow('must be finite');

    expect(() =>
      decodeConnectionsCorridorLayout(
        {
          ...layout,
          nodes: layout.nodes.map((node) => ({
            ...node,
            ports: node.ports.map((port) =>
              port.id === firstEdge.sourcePortId
                ? { ...port, id: `${port.id}-moved` }
                : port,
            ),
          })),
        },
        graph,
        metrics,
      ),
    ).toThrow('attached edge 0 incorrectly');
  });

  it('decodes ready and failed alternatives exhaustively', () => {
    expect(
      decodeConnectionsCorridorWorkerResponse({
        type: 'ready',
        policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
      }),
    ).toEqual({
      type: 'ready',
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
    });
    expect(
      decodeConnectionsCorridorWorkerResponse({
        type: 'failed',
        requestId: 8,
        generation: 3,
        policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
        failure: 'route failed',
      }),
    ).toMatchObject({ type: 'failed', failure: 'route failed' });
    expect(() =>
      decodeConnectionsCorridorWorkerResponse({
        type: 'unexpected',
        requestId: 8,
        generation: 3,
        policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
      }),
    ).toThrow('unknown type');
  });
});
