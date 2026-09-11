import { describe, expect, it } from 'vitest';
import { buildConnectionsGraph } from '@/lib/domain/graph';
import type { CardRecord } from '@/lib/domain/types';
import { invariant } from '@/lib/shared/invariant';
import { fixtureCardId } from '@/tests/fixtures/ids';
import {
  CONNECTIONS_LAYOUT_ALGORITHM_OPTIONS,
  connectionsLayoutOptions,
  layoutConnectionsGraph,
  type ConnectionsLayout,
  type ConnectionsLayoutEdge,
  type ConnectionsLayoutGraph,
  type ConnectionsLayoutMetrics,
  type ConnectionsLayoutNode,
  type LayoutPoint,
} from '@/lib/graph/elk-layout';

type Fixture = {
  name: string;
  nodes: string[];
  edges: [string, string][];
};

const fixtures: Fixture[] = [
  {
    name: 'reported C→A / C→B / A→B',
    nodes: ['A', 'B', 'C'],
    edges: [
      ['C', 'A'],
      ['C', 'B'],
      ['A', 'B'],
    ],
  },
  {
    name: 'diamond',
    nodes: ['A', 'B', 'C', 'D'],
    edges: [
      ['A', 'B'],
      ['A', 'C'],
      ['B', 'D'],
      ['C', 'D'],
    ],
  },
  {
    name: 'fan-out and fan-in',
    nodes: ['A', 'B', 'C', 'D', 'E', 'Z'],
    edges: [
      ['A', 'B'],
      ['A', 'C'],
      ['A', 'D'],
      ['A', 'E'],
      ['B', 'Z'],
      ['C', 'Z'],
      ['D', 'Z'],
      ['E', 'Z'],
    ],
  },
  {
    name: 'cycle',
    nodes: ['A', 'B', 'C'],
    edges: [
      ['A', 'B'],
      ['B', 'C'],
      ['C', 'A'],
    ],
  },
  { name: 'self link', nodes: ['A'], edges: [['A', 'A']] },
  {
    name: 'mutual links',
    nodes: ['A', 'B'],
    edges: [
      ['A', 'B'],
      ['B', 'A'],
    ],
  },
  {
    name: 'disconnected components',
    nodes: ['A', 'B', 'C', 'D', 'E'],
    edges: [
      ['A', 'B'],
      ['C', 'D'],
    ],
  },
  {
    name: 'dense K3,3',
    nodes: ['A', 'B', 'C', 'X', 'Y', 'Z'],
    edges: ['A', 'B', 'C'].flatMap((source) =>
      ['X', 'Y', 'Z'].map((target): [string, string] => [source, target]),
    ),
  },
];

function fixtureGraph(fixture: Fixture): ConnectionsLayoutGraph {
  const outgoing = new Map(fixture.nodes.map((id) => [id, [] as string[]]));
  for (const [source, target] of fixture.edges) {
    const targets = outgoing.get(source);
    invariant(targets, `Fixture is missing source ${source}`);
    targets.push(target);
  }
  const cards: CardRecord[] = fixture.nodes.map((id, index) => ({
    id: fixtureCardId(id),
    displayId: { kind: 'official', value: index + 1 },
    title: id,
    body: (outgoing.get(id) ?? []).map((targetCardId) => ({
      type: 'link',
      targetCardId: fixtureCardId(targetCardId),
    })),
    createdAt: index,
    updatedAt: index,
    localRevision: 1,
    serverRevision: 1,
  }));
  const graph = buildConnectionsGraph(cards);
  return {
    nodes: graph.nodes.map(({ card }) => ({ id: card.id })),
    edges: graph.edges,
  };
}

const compactMetrics: ConnectionsLayoutMetrics = {
  nodeWidth: 148,
  nodeHeight: 56,
  portSize: 2,
  componentSpacing: 64,
  nodeSpacing: 48,
  edgeNodeSpacing: 24,
  layerSpacing: 80,
  edgeLayerSpacing: 28,
  padding: { top: 16, right: 16, bottom: 16, left: 16 },
};

const spaciousMetrics: ConnectionsLayoutMetrics = {
  nodeWidth: 232,
  nodeHeight: 96,
  portSize: 4,
  componentSpacing: 128,
  nodeSpacing: 96,
  edgeNodeSpacing: 44,
  layerSpacing: 148,
  edgeLayerSpacing: 56,
  padding: { top: 32, right: 40, bottom: 36, left: 44 },
};

function overlaps(
  left: ConnectionsLayoutNode,
  right: ConnectionsLayoutNode,
): boolean {
  return (
    left.x < right.x + right.width &&
    left.x + left.width > right.x &&
    left.y < right.y + right.height &&
    left.y + left.height > right.y
  );
}

function sectionPoints(edge: ConnectionsLayoutEdge): LayoutPoint[][] {
  return edge.sections.map((section) => [
    section.startPoint,
    ...section.bendPoints,
    section.endPoint,
  ]);
}

function segmentCrossesRectInterior(
  start: LayoutPoint,
  end: LayoutPoint,
  node: ConnectionsLayoutNode,
): boolean {
  const epsilon = 1e-7;
  const left = node.x + epsilon;
  const right = node.x + node.width - epsilon;
  const top = node.y + epsilon;
  const bottom = node.y + node.height - epsilon;
  const deltaX = end.x - start.x;
  const deltaY = end.y - start.y;
  let minimum = 0;
  let maximum = 1;

  for (const [origin, delta, low, high] of [
    [start.x, deltaX, left, right],
    [start.y, deltaY, top, bottom],
  ] as const) {
    if (Math.abs(delta) < epsilon) {
      if (origin <= low || origin >= high) return false;
      continue;
    }
    const first = (low - origin) / delta;
    const second = (high - origin) / delta;
    minimum = Math.max(minimum, Math.min(first, second));
    maximum = Math.min(maximum, Math.max(first, second));
    if (minimum > maximum) return false;
  }
  return maximum >= 0 && minimum <= 1;
}

function expectFiniteLayout(layout: ConnectionsLayout) {
  expect(Number.isFinite(layout.width)).toBe(true);
  expect(Number.isFinite(layout.height)).toBe(true);
  expect(layout.width).toBeGreaterThan(0);
  expect(layout.height).toBeGreaterThan(0);
  for (const node of layout.nodes) {
    for (const value of [node.x, node.y, node.width, node.height]) {
      expect(Number.isFinite(value)).toBe(true);
    }
    expect(node.x).toBeGreaterThanOrEqual(0);
    expect(node.y).toBeGreaterThanOrEqual(0);
    expect(node.x + node.width).toBeLessThanOrEqual(layout.width);
    expect(node.y + node.height).toBeLessThanOrEqual(layout.height);
    for (const port of node.ports) {
      for (const value of [port.x, port.y, port.width, port.height]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
  }
  for (const edge of layout.edges) {
    expect(edge.sections.length).toBeGreaterThan(0);
    for (const points of sectionPoints(edge)) {
      expect(points.length).toBeGreaterThanOrEqual(2);
      expect(
        new Set(points.map((point) => `${point.x},${point.y}`)).size,
      ).toBeGreaterThan(1);
      for (const point of points) {
        expect(Number.isFinite(point.x)).toBe(true);
        expect(Number.isFinite(point.y)).toBe(true);
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(layout.width);
        expect(point.y).toBeLessThanOrEqual(layout.height);
      }
    }
  }
}

function expectEdgePortsApplied(layout: ConnectionsLayout) {
  const ports = new Map(
    layout.nodes.flatMap((node) =>
      node.ports.map((port) => [port.id, port] as const),
    ),
  );
  for (const edge of layout.edges) {
    const sourcePort = ports.get(edge.sourcePortId);
    const targetPort = ports.get(edge.targetPortId);
    const firstSection = edge.sections[0];
    const lastSection = edge.sections.at(-1);
    invariant(sourcePort, `Missing source port ${edge.sourcePortId}`);
    invariant(targetPort, `Missing target port ${edge.targetPortId}`);
    invariant(firstSection, `Missing first section for ${edge.id}`);
    invariant(lastSection, `Missing last section for ${edge.id}`);
    const start = firstSection.startPoint;
    const end = lastSection.endPoint;

    expect(sourcePort.side).toBe('EAST');
    expect(targetPort.side).toBe('WEST');
    expect(start.x).toBeCloseTo(sourcePort.x + sourcePort.width);
    expect(start.y).toBeGreaterThanOrEqual(sourcePort.y);
    expect(start.y).toBeLessThanOrEqual(sourcePort.y + sourcePort.height);
    expect(end.x).toBeCloseTo(targetPort.x);
    expect(end.y).toBeGreaterThanOrEqual(targetPort.y);
    expect(end.y).toBeLessThanOrEqual(targetPort.y + targetPort.height);
  }
}

function expectNoNodeOrEdgeIntrusions(layout: ConnectionsLayout) {
  for (let left = 0; left < layout.nodes.length; left += 1) {
    for (let right = left + 1; right < layout.nodes.length; right += 1) {
      const leftNode = layout.nodes[left];
      const rightNode = layout.nodes[right];
      invariant(leftNode, `Missing layout node ${left}`);
      invariant(rightNode, `Missing layout node ${right}`);
      expect(overlaps(leftNode, rightNode)).toBe(false);
    }
  }

  for (const edge of layout.edges) {
    const otherNodes = layout.nodes.filter(
      (node) => node.id !== edge.sourceCardId && node.id !== edge.targetCardId,
    );
    for (const points of sectionPoints(edge)) {
      for (let index = 1; index < points.length; index += 1) {
        const start = points[index - 1];
        const end = points[index];
        invariant(start, `Missing segment start ${index - 1}`);
        invariant(end, `Missing segment end ${index}`);
        for (const node of otherNodes) {
          expect(segmentCrossesRectInterior(start, end, node)).toBe(false);
        }
      }
    }
  }
}

describe('ELK connections layout', () => {
  it('uses the layered orthogonal algorithm and explicit spacing/crossing settings', () => {
    expect(CONNECTIONS_LAYOUT_ALGORITHM_OPTIONS).toMatchObject({
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.separateConnectedComponents': 'true',
    });
    expect(connectionsLayoutOptions(spaciousMetrics)).toMatchObject({
      'elk.spacing.componentComponent': '128',
      'elk.spacing.nodeNode': '96',
      'elk.layered.spacing.nodeNodeBetweenLayers': '148',
      'elk.padding': '[top=32,left=44,bottom=36,right=40]',
    });
  });

  for (const fixture of fixtures) {
    for (const [density, metrics] of [
      ['compact', compactMetrics],
      ['spacious', spaciousMetrics],
    ] as const) {
      it(`returns deterministic, finite, node-safe ${density} geometry for ${fixture.name}`, async () => {
        const graph = fixtureGraph(fixture);
        const first = await layoutConnectionsGraph(graph, metrics);
        const second = await layoutConnectionsGraph(graph, metrics);

        expect(first).toEqual(second);
        expect(first.nodes.map((node) => node.id)).toEqual(
          fixture.nodes.map(fixtureCardId),
        );
        expect(first.edges).toHaveLength(fixture.edges.length);
        expect(
          first.nodes.every((node) => node.width === metrics.nodeWidth),
        ).toBe(true);
        expect(
          first.nodes.every((node) => node.height === metrics.nodeHeight),
        ).toBe(true);
        expect(
          first.nodes
            .flatMap((node) => node.ports)
            .every(
              (port) =>
                port.width === metrics.portSize &&
                port.height === metrics.portSize,
            ),
        ).toBe(true);
        expectFiniteLayout(first);
        expectNoNodeOrEdgeIntrusions(first);
        expectEdgePortsApplied(first);
        for (const edge of first.edges) {
          const firstSection = edge.sections[0];
          invariant(firstSection, `Missing section for ${edge.id}`);
          expect(firstSection.incomingShape).toBe(edge.sourcePortId);
          expect(edge.sections.at(-1)?.outgoingShape).toBe(edge.targetPortId);
        }
      });
    }
  }

  it('keeps self and mutual routes non-degenerate and visually distinct', async () => {
    const graph = fixtureGraph({
      name: 'combined loops',
      nodes: ['A', 'B'],
      edges: [
        ['A', 'A'],
        ['A', 'B'],
        ['B', 'A'],
      ],
    });
    const layout = await layoutConnectionsGraph(graph, compactMetrics);
    const self = layout.edges.find(
      (edge) =>
        edge.sourceCardId === fixtureCardId('A') &&
        edge.targetCardId === fixtureCardId('A'),
    );
    const forward = layout.edges.find(
      (edge) =>
        edge.sourceCardId === fixtureCardId('A') &&
        edge.targetCardId === fixtureCardId('B'),
    );
    const backward = layout.edges.find(
      (edge) =>
        edge.sourceCardId === fixtureCardId('B') &&
        edge.targetCardId === fixtureCardId('A'),
    );
    invariant(self, 'Missing self edge');
    invariant(forward, 'Missing forward edge');
    invariant(backward, 'Missing backward edge');
    const signature = (edge: ConnectionsLayoutEdge) =>
      JSON.stringify(sectionPoints(edge));

    expect(sectionPoints(self).flat()).toHaveLength(6);
    expect(
      new Set(
        sectionPoints(self)
          .flat()
          .map((point) => `${point.x},${point.y}`),
      ).size,
    ).toBeGreaterThan(2);
    expect(signature(forward)).not.toBe(signature(backward));
    expect(signature(forward)).not.toBe(signature(self));
    expect(signature(backward)).not.toBe(signature(self));
  });
});
