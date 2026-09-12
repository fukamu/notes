import { describe, expect, it } from 'vitest';
import { createMainThreadConnectionsLayoutRunner } from '@/lib/client/connections-layout-main-thread';
import type { ConnectionsLayoutNode } from '@/lib/graph/elk-layout';
import {
  measureRouteQuality,
  relativeConnectionsPortSides,
  routeConnectionsWithVisibilityGraph,
} from '@/tests/benchmarks/connections-routing-support';
import {
  connectionsBenchmarkFixtures,
  connectionsFixtureGraph,
  spaciousConnectionsMetrics,
} from '@/tests/fixtures/connections-layout';

const candidateFixture = {
  name: 'routing research combined loop',
  nodes: ['A', 'B'],
  edges: [
    ['A', 'A'],
    ['A', 'B'],
    ['B', 'A'],
  ] as [string, string][],
};

describe('connections routing research functions', () => {
  it('keeps every hard constraint on the production FREE default corpus', async () => {
    const runner = createMainThreadConnectionsLayoutRunner();
    for (const fixture of connectionsBenchmarkFixtures) {
      const graph = connectionsFixtureGraph(fixture);
      const layout = await runner(graph, spaciousConnectionsMetrics);
      const quality = measureRouteQuality(layout, 'orthogonal-polyline', {
        expectedGraph: graph,
        nodeClearance: spaciousConnectionsMetrics.edgeNodeSpacing / 2,
      });
      expect(quality, fixture.name).toMatchObject({
        nonFiniteValues: 0,
        semanticEdgeErrors: 0,
        endpointMismatches: 0,
        arrowTangentErrors: 0,
        sectionDiscontinuities: 0,
        degenerateEdges: 0,
        nodeIntrusions: 0,
        clearanceIntrusions: 0,
        indistinguishableMutualPairs: 0,
      });
      if (fixture.name === 'mutual links') {
        expect(quality.totalRouteLength).toBe(296);
        expect(quality.mutualReverseExcessLength).toBe(0);
      }
      if (fixture.name === 'bidirectional five-node cycle') {
        expect(quality.totalRouteLength).toBe(3_094);
        expect(quality.mutualReverseExcessLength).toBe(18);
      }
    }
  });

  it('selects relative sides deterministically for horizontal, vertical, diagonal, and self edges', () => {
    const graph = connectionsFixtureGraph({
      name: 'relative sides',
      nodes: ['A', 'B', 'C', 'D'],
      edges: [
        ['A', 'B'],
        ['A', 'C'],
        ['A', 'D'],
        ['A', 'A'],
      ],
    });
    const positions = [
      { x: 0, y: 0 },
      { x: 300, y: 0 },
      { x: 0, y: 300 },
      { x: -200, y: -400 },
    ];
    const nodes: ConnectionsLayoutNode[] = graph.nodes.map(({ id }, index) => ({
      id,
      x: positions[index]?.x ?? 0,
      y: positions[index]?.y ?? 0,
      width: 100,
      height: 50,
      ports: [],
    }));

    expect(relativeConnectionsPortSides(graph, nodes)).toEqual([
      { source: 'EAST', target: 'SOUTH' },
      { source: 'EAST', target: 'WEST' },
      { source: 'SOUTH', target: 'NORTH' },
      { source: 'NORTH', target: 'SOUTH' },
    ]);
  });

  it('lets ELK choose decoded four-side ports without weakening route contracts', async () => {
    const graph = connectionsFixtureGraph(candidateFixture);
    const inputSnapshot = structuredClone(graph);
    const runner = createMainThreadConnectionsLayoutRunner({
      edgeRouting: 'ORTHOGONAL',
      portPolicy: 'FREE',
      edgePortSides: 'ELK',
    });
    const first = await runner(graph, spaciousConnectionsMetrics);
    const second = await runner(graph, spaciousConnectionsMetrics);
    const quality = measureRouteQuality(first, 'orthogonal-polyline', {
      expectedGraph: graph,
      nodeClearance: spaciousConnectionsMetrics.edgeNodeSpacing / 2,
    });

    expect(graph).toEqual(inputSnapshot);
    expect(second).toEqual(first);
    expect(
      new Set(
        first.nodes.flatMap((node) => node.ports.map((port) => port.side)),
      ),
    ).toContain('NORTH');
    expect(quality).toMatchObject({
      nonFiniteValues: 0,
      semanticEdgeErrors: 0,
      endpointMismatches: 0,
      arrowTangentErrors: 0,
      sectionDiscontinuities: 0,
      degenerateEdges: 0,
      nodeIntrusions: 0,
      clearanceIntrusions: 0,
      indistinguishableMutualPairs: 0,
    });
  });

  it('keeps the visibility prototype pure while exposing its mutual-route failure', async () => {
    const graph = connectionsFixtureGraph({
      name: 'visibility mutual route',
      nodes: ['A', 'B'],
      edges: [
        ['A', 'B'],
        ['B', 'A'],
      ],
    });
    const layout = await createMainThreadConnectionsLayoutRunner({
      edgeRouting: 'ORTHOGONAL',
      portPolicy: 'FIXED_SIDE',
    })(graph, spaciousConnectionsMetrics);
    const inputSnapshot = structuredClone(layout);
    const first = routeConnectionsWithVisibilityGraph(
      layout,
      graph,
      spaciousConnectionsMetrics.edgeNodeSpacing / 2,
    );
    const second = routeConnectionsWithVisibilityGraph(
      layout,
      graph,
      spaciousConnectionsMetrics.edgeNodeSpacing / 2,
    );
    const quality = measureRouteQuality(first, 'orthogonal-polyline', {
      expectedGraph: graph,
      nodeClearance: spaciousConnectionsMetrics.edgeNodeSpacing / 2,
    });

    expect(layout).toEqual(inputSnapshot);
    expect(second).toEqual(first);
    expect(quality.indistinguishableMutualPairs).toBe(1);
    expect(quality.nodeIntrusions).toBe(0);
    expect(quality.clearanceIntrusions).toBe(0);
  });
});
