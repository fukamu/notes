import { describe, expect, it } from 'vitest';
import { buildConnectionsGraph } from '@/lib/domain/graph';
import type { CardRecord } from '@/lib/domain/types';
import {
  CONNECTIONS_LAYOUT_OPTIONS,
  layoutConnectionsGraph,
  type ConnectionsLayout,
  type ConnectionsLayoutEdge,
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

function fixtureGraph(fixture: Fixture) {
  const outgoing = new Map(fixture.nodes.map((id) => [id, [] as string[]]));
  for (const [source, target] of fixture.edges)
    outgoing.get(source)!.push(target);
  const cards: CardRecord[] = fixture.nodes.map((id, index) => ({
    id,
    displayId: { kind: 'official', value: index + 1 },
    title: id,
    body: outgoing
      .get(id)!
      .map((targetCardId) => ({ type: 'link', targetCardId })),
    createdAt: index,
    updatedAt: index,
    localRevision: 1,
    serverRevision: 1,
  }));
  return buildConnectionsGraph(cards);
}

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
    const sourcePort = ports.get(edge.sourcePortId)!;
    const targetPort = ports.get(edge.targetPortId)!;
    const start = edge.sections[0].startPoint;
    const end = edge.sections.at(-1)!.endPoint;

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
      expect(overlaps(layout.nodes[left], layout.nodes[right])).toBe(false);
    }
  }

  for (const edge of layout.edges) {
    const otherNodes = layout.nodes.filter(
      (node) => node.id !== edge.sourceCardId && node.id !== edge.targetCardId,
    );
    for (const points of sectionPoints(edge)) {
      for (let index = 1; index < points.length; index += 1) {
        for (const node of otherNodes) {
          expect(
            segmentCrossesRectInterior(points[index - 1], points[index], node),
          ).toBe(false);
        }
      }
    }
  }
}

describe('ELK connections layout', () => {
  it('uses the layered orthogonal algorithm and explicit spacing/crossing settings', () => {
    expect(CONNECTIONS_LAYOUT_OPTIONS).toMatchObject({
      'elk.algorithm': 'layered',
      'elk.direction': 'RIGHT',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.cycleBreaking.strategy': 'GREEDY',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.separateConnectedComponents': 'true',
    });
  });

  for (const fixture of fixtures) {
    it(`returns deterministic, finite, node-safe geometry for ${fixture.name}`, async () => {
      const graph = fixtureGraph(fixture);
      const first = await layoutConnectionsGraph(graph);
      const second = await layoutConnectionsGraph(graph);

      expect(first).toEqual(second);
      expect(first.nodes.map((node) => node.id)).toEqual(fixture.nodes);
      expect(first.edges).toHaveLength(fixture.edges.length);
      expectFiniteLayout(first);
      expectNoNodeOrEdgeIntrusions(first);
      expectEdgePortsApplied(first);
      for (const edge of first.edges) {
        expect(edge.sections[0].incomingShape).toBe(edge.sourcePortId);
        expect(edge.sections.at(-1)?.outgoingShape).toBe(edge.targetPortId);
      }
    });
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
    const layout = await layoutConnectionsGraph(graph);
    const self = layout.edges.find(
      (edge) => edge.sourceCardId === 'A' && edge.targetCardId === 'A',
    )!;
    const forward = layout.edges.find(
      (edge) => edge.sourceCardId === 'A' && edge.targetCardId === 'B',
    )!;
    const backward = layout.edges.find(
      (edge) => edge.sourceCardId === 'B' && edge.targetCardId === 'A',
    )!;
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
