import { describe, expect, it } from 'vitest';
import {
  connectionsLayoutGraphKey,
  connectionsSemanticLayoutKey,
} from '@/lib/graph/connections-layout-key';
import { CONNECTIONS_LAYOUT_POLICY_REVISION } from '@/lib/graph/connections-layout-policy';
import type {
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';
import { fixtureCardId } from '@/tests/fixtures/ids';

const firstId = fixtureCardId('layout-key-first');
const secondId = fixtureCardId('layout-key-second');
const graph: ConnectionsLayoutGraph = {
  nodes: [{ id: firstId }, { id: secondId }],
  edges: [{ sourceCardId: firstId, targetCardId: secondId }],
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

describe('connections layout key', () => {
  it('shares one policy-aware key between semantic and geometry inputs', () => {
    const geometryKey = connectionsLayoutGraphKey(graph, metrics);
    const semanticKey = connectionsSemanticLayoutKey(
      {
        currentCardId: firstId,
        nodes: graph.nodes.map((node, index) => ({
          cardId: node.id,
          displayLabel: `${index + 1}`,
          title: `card ${index + 1}`,
          accessibleName: `card ${index + 1}`,
          current: index === 0,
        })),
        edges: graph.edges.map((edge) => ({
          ...edge,
          accessibleName: 'first to second',
        })),
      },
      metrics,
    );

    expect(semanticKey).toBe(geometryKey);
    expect(geometryKey).toContain(CONNECTIONS_LAYOUT_POLICY_REVISION);
  });

  it('distinguishes input order, edge direction, and layout metrics', () => {
    const original = connectionsLayoutGraphKey(graph, metrics);
    expect(
      connectionsLayoutGraphKey(
        { ...graph, nodes: [...graph.nodes].reverse() },
        metrics,
      ),
    ).not.toBe(original);
    expect(
      connectionsLayoutGraphKey(
        {
          ...graph,
          edges: [{ sourceCardId: secondId, targetCardId: firstId }],
        },
        metrics,
      ),
    ).not.toBe(original);
    expect(
      connectionsLayoutGraphKey(graph, { ...metrics, nodeWidth: 197 }),
    ).not.toBe(original);
  });
});
