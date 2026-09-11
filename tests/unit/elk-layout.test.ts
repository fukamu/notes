import { describe, expect, it } from 'vitest';
import { invariant } from '@/lib/shared/invariant';
import {
  compactConnectionsMetrics,
  connectionsCompatibilityFixtures,
  connectionsFixtureGraph,
  spaciousConnectionsMetrics,
} from '@/tests/fixtures/connections-layout';
import { fixtureCardId } from '@/tests/fixtures/ids';
import {
  CONNECTIONS_LAYOUT_ALGORITHM_OPTIONS,
  connectionsLayoutOptions,
  createConnectionsLayoutRunner,
  layoutConnectionsGraph,
  type ConnectionsLayout,
  type ConnectionsLayoutEdge,
  type ConnectionsLayoutNode,
  type LayoutPoint,
} from '@/lib/graph/elk-layout';

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
    expect(connectionsLayoutOptions(spaciousConnectionsMetrics)).toMatchObject({
      'elk.spacing.componentComponent': '128',
      'elk.spacing.nodeNode': '96',
      'elk.layered.spacing.nodeNodeBetweenLayers': '148',
      'elk.padding': '[top=32,left=44,bottom=36,right=40]',
    });
  });

  it('exposes explicit benchmark options without changing the production default', () => {
    const options = connectionsLayoutOptions(spaciousConnectionsMetrics, {
      edgeRouting: 'SPLINES',
      portPolicy: 'FIXED_ORDER',
      splineRoutingMode: 'CONSERVATIVE',
      addUnnecessaryBendpoints: false,
      favorStraightEdges: true,
      straightnessPriority: 8,
      shortnessPriority: 8,
    });

    expect(options).toMatchObject({
      'elk.edgeRouting': 'SPLINES',
      'elk.layered.edgeRouting.splines.mode': 'CONSERVATIVE',
      'elk.layered.unnecessaryBendpoints': 'false',
      'elk.layered.nodePlacement.favorStraightEdges': 'true',
    });
    expect(connectionsLayoutOptions(spaciousConnectionsMetrics)).toMatchObject({
      'elk.edgeRouting': 'ORTHOGONAL',
    });
  });

  it('rejects invalid candidate priorities at the layout boundary', async () => {
    const fixture = connectionsCompatibilityFixtures[0];
    invariant(fixture, 'Missing reported fixture');
    const runner = createConnectionsLayoutRunner({
      edgeRouting: 'ORTHOGONAL',
      portPolicy: 'FIXED_SIDE',
      straightnessPriority: -1,
    });

    await expect(
      runner(connectionsFixtureGraph(fixture), spaciousConnectionsMetrics),
    ).rejects.toThrow('priority straightness must be a non-negative integer');
  });

  for (const fixture of connectionsCompatibilityFixtures) {
    for (const [density, metrics] of [
      ['compact', compactConnectionsMetrics],
      ['spacious', spaciousConnectionsMetrics],
    ] as const) {
      it(`returns deterministic, finite, node-safe ${density} geometry for ${fixture.name}`, async () => {
        const graph = connectionsFixtureGraph(fixture);
        const inputSnapshot = structuredClone(graph);
        const first = await layoutConnectionsGraph(graph, metrics);
        const second = await layoutConnectionsGraph(graph, metrics);

        expect(graph).toEqual(inputSnapshot);
        expect(first).toEqual(second);
        expect(first.nodes.map((node) => node.id)).toEqual(
          graph.nodes.map((node) => node.id),
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
    const combinedFixture = {
      name: 'combined loops',
      nodes: ['A', 'B'],
      edges: [
        ['A', 'A'],
        ['A', 'B'],
        ['B', 'A'],
      ] as [string, string][],
    };
    const graph = connectionsFixtureGraph(combinedFixture);
    const layout = await layoutConnectionsGraph(
      graph,
      compactConnectionsMetrics,
    );
    const self = layout.edges.find(
      (edge) =>
        edge.sourceCardId === fixtureCardId(`${combinedFixture.name}-A`) &&
        edge.targetCardId === fixtureCardId(`${combinedFixture.name}-A`),
    );
    const forward = layout.edges.find(
      (edge) =>
        edge.sourceCardId === fixtureCardId(`${combinedFixture.name}-A`) &&
        edge.targetCardId === fixtureCardId(`${combinedFixture.name}-B`),
    );
    const backward = layout.edges.find(
      (edge) =>
        edge.sourceCardId === fixtureCardId(`${combinedFixture.name}-B`) &&
        edge.targetCardId === fixtureCardId(`${combinedFixture.name}-A`),
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
