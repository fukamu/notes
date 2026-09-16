import { describe, expect, it } from 'vitest';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import type { CardId } from '@/lib/domain/id';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  createFullNetworkTopology,
  defaultFullNetworkLayoutConfiguration,
  layoutFullNetworkTopology,
} from '@/lib/graph/full-network-layout';
import {
  createFullNetworkRouting,
  defaultFullNetworkRoutingConfiguration,
  fullNetworkDirectedEdgeIdentity,
  fullNetworkRouteAt,
  fullNetworkRouteIntersectsNodeInterior,
  fullNetworkRouteLength,
  fullNetworkRoutingIndexBytes,
  queryFullNetworkRoutes,
  validateFullNetworkRouting,
} from '@/lib/graph/full-network-routing';
import { createClientPerformanceFixture } from '@/tests/fixtures/client-performance';
import { fixtureCardId } from '@/tests/fixtures/ids';

const ids = Array.from({ length: 10 }, (_, index) =>
  fixtureCardId(`full-routing-${index}`),
);

function id(index: number): CardId {
  const value = ids[index];
  if (value === undefined) throw new Error(`Missing fixture id ${index}`);
  return value;
}

function input(
  edges: readonly (readonly [number, number])[],
  nodeIds: readonly CardId[] = ids,
  currentCardId: CardId = id(0),
): ConnectionsInputModel {
  return {
    currentCardId,
    nodes: nodeIds.map((cardId, index) => ({
      cardId,
      displayLabel: `#${index + 1}`,
      title: `Card ${index + 1}`,
      accessibleName: `Card ${index + 1}`,
      current: cardId === currentCardId,
    })),
    edges: edges.map(([source, target]) => ({
      sourceCardId: nodeIds[source] ?? id(source),
      targetCardId: nodeIds[target] ?? id(target),
      accessibleName: `${source} to ${target}`,
    })),
  };
}

function routed(edges: readonly (readonly [number, number])[]) {
  const topology = createFullNetworkTopology(input(edges));
  const layout = layoutFullNetworkTopology(topology);
  const routing = createFullNetworkRouting(
    topology,
    layout,
    defaultFullNetworkLayoutConfiguration,
  );
  return { topology, layout, routing };
}

function routeSegments(coordinates: Float32Array) {
  const output: Array<readonly [number, number, number, number]> = [];
  for (let offset = 0; offset + 3 < coordinates.length; offset += 2) {
    const fromX = coordinates[offset];
    const fromY = coordinates[offset + 1];
    const toX = coordinates[offset + 2];
    const toY = coordinates[offset + 3];
    if (
      fromX === undefined ||
      fromY === undefined ||
      toX === undefined ||
      toY === undefined
    ) {
      throw new Error(`Route omitted segment ${offset / 2}`);
    }
    output.push([fromX, fromY, toX, toY]);
  }
  return output;
}

describe('full-network routing and spatial index', () => {
  it('keeps every directed semantic edge as one stable route/index identity', () => {
    const edges = [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 0],
      [1, 2],
      [2, 0],
      [2, 1],
      [3, 4],
      [4, 3],
    ] as const;
    const { topology, routing } = routed(edges);

    expect(routing.routeCount).toBe(edges.length);
    expect(
      edges.map((_, edgeIndex) =>
        fullNetworkDirectedEdgeIdentity(topology, edgeIndex),
      ),
    ).toEqual(
      edges.map(([source, target], edgeIndex) => ({
        edgeIndex,
        id: `full-network-edge-v1:${id(source)}:${id(target)}`,
        sourceCardId: id(source),
        targetCardId: id(target),
      })),
    );
    expect([...queryFullNetworkRoutes(routing, routing.bounds)]).toEqual(
      edges.map((_, edgeIndex) => edgeIndex),
    );
  });

  it('routes self, mutual, cyclic, and high-degree edges without non-endpoint node intrusion', () => {
    const edges = [
      [0, 0],
      [0, 1],
      [0, 2],
      [0, 3],
      [0, 4],
      [0, 5],
      [0, 6],
      [0, 7],
      [1, 0],
      [1, 2],
      [2, 0],
      [2, 1],
    ] as const;
    const { topology, layout, routing } = routed(edges);
    const routes = edges.map((_, edgeIndex) =>
      fullNetworkRouteAt(routing, edgeIndex),
    );

    expect(routes[1]?.coordinates).not.toEqual(routes[8]?.coordinates);
    const self = routes[0];
    if (!self) throw new Error('Fixture omitted its self route');
    expect(self.coordinates.slice(0, 2)).toEqual(self.coordinates.slice(-2));

    for (const route of routes) {
      expect([...route.coordinates].every(Number.isFinite)).toBe(true);
      for (const [fromX, fromY, toX, toY] of routeSegments(route.coordinates)) {
        expect(fromX === toX || fromY === toY).toBe(true);
      }
      const source = topology.sources[route.edgeIndex];
      const target = topology.targets[route.edgeIndex];
      if (source === undefined || target === undefined) {
        throw new Error('Fixture omitted route endpoints');
      }
      for (let node = 0; node < topology.nodeIds.length; node += 1) {
        if (node === source || node === target) continue;
        expect(
          fullNetworkRouteIntersectsNodeInterior(
            route,
            layout,
            node,
            defaultFullNetworkRoutingConfiguration,
          ),
        ).toBe(false);
      }
      if (source !== target) {
        const sourceX = layout.x[source];
        const sourceY = layout.y[source];
        const targetX = layout.x[target];
        const targetY = layout.y[target];
        if (
          sourceX === undefined ||
          sourceY === undefined ||
          targetX === undefined ||
          targetY === undefined
        ) {
          throw new Error('Fixture omitted endpoint geometry');
        }
        const directLength =
          Math.abs(targetX - sourceX) + Math.abs(targetY - sourceY);
        expect(fullNetworkRouteLength(route)).toBeLessThanOrEqual(
          directLength +
            defaultFullNetworkLayoutConfiguration.cellWidth * 2 +
            defaultFullNetworkLayoutConfiguration.cellHeight +
            0.000_1,
        );
      }
    }
  });

  it('finds a route crossing the viewport when both endpoints are outside', () => {
    const { layout, routing } = routed([[0, 1]]);
    const route = fullNetworkRouteAt(routing, 0);
    const segment = routeSegments(route.coordinates).find(
      ([fromX, fromY, toX, toY]) =>
        Math.abs(toX - fromX) + Math.abs(toY - fromY) > 0 &&
        fromX !== layout.x[0] &&
        fromY !== layout.y[0],
    );
    if (!segment) throw new Error('Fixture omitted an interior route segment');
    const [fromX, fromY, toX, toY] = segment;
    const centerX = (fromX + toX) / 2;
    const centerY = (fromY + toY) / 2;
    const viewport = {
      minX: centerX - 0.25,
      minY: centerY - 0.25,
      maxX: centerX + 0.25,
      maxY: centerY + 0.25,
    };

    expect([...queryFullNetworkRoutes(routing, viewport)]).toEqual([0]);
    expect(
      pointInside(viewport, layout.x[0], layout.y[0]) ||
        pointInside(viewport, layout.x[1], layout.y[1]),
    ).toBe(false);
    expect(
      queryFullNetworkRoutes(routing, {
        minX: routing.bounds.maxX + 10,
        minY: routing.bounds.maxY + 10,
        maxX: routing.bounds.maxX + 11,
        maxY: routing.bounds.maxY + 11,
      }),
    ).toHaveLength(0);
  });

  it('keeps a directed edge ID stable when unrelated node indexes shift', () => {
    const firstTopology = createFullNetworkTopology(
      input([[0, 1]], [id(0), id(1)], id(0)),
    );
    const secondTopology = createFullNetworkTopology(
      input([[1, 2]], [id(9), id(0), id(1)], id(0)),
    );
    expect(fullNetworkDirectedEdgeIdentity(firstTopology, 0).id).toBe(
      fullNetworkDirectedEdgeIdentity(secondTopology, 0).id,
    );
  });

  it('indexes the exact 10,000-card fixture with bounded O(E) storage', () => {
    const cards = createClientPerformanceFixture();
    const current = cards[5_000];
    if (!current) throw new Error('10k fixture omitted current card');
    const topology = createFullNetworkTopology(
      selectConnectionsViewModel(cards, current.id),
    );
    const layout = layoutFullNetworkTopology(topology);
    const routing = createFullNetworkRouting(
      topology,
      layout,
      defaultFullNetworkLayoutConfiguration,
    );

    expect(routing.routeCount).toBe(19_951);
    expect(fullNetworkRoutingIndexBytes(routing)).toBe(19_951 * 24);
    const allEdges = queryFullNetworkRoutes(routing, routing.bounds);
    expect(allEdges).toHaveLength(19_951);
    expect(allEdges[0]).toBe(0);
    expect(allEdges[19_950]).toBe(19_950);
  });

  it('fails closed for stale layout configuration, unsafe clearance, and a corrupt index', () => {
    const { topology, layout } = routed([
      [0, 1],
      [1, 2],
    ]);
    expect(() =>
      createFullNetworkRouting(topology, layout, {
        ...defaultFullNetworkLayoutConfiguration,
        cellWidth: 20,
      }),
    ).toThrow('stale');
    expect(() =>
      createFullNetworkRouting(
        topology,
        layout,
        defaultFullNetworkLayoutConfiguration,
        {
          ...defaultFullNetworkRoutingConfiguration,
          nodeHalfWidth: defaultFullNetworkLayoutConfiguration.cellWidth / 2,
        },
      ),
    ).toThrow('clearance');

    const routing = createFullNetworkRouting(
      topology,
      layout,
      defaultFullNetworkLayoutConfiguration,
    );
    routing.edgeIndexesByMinimumX[0] = routing.edgeIndexesByMinimumX[1] ?? 0;
    expect(() => validateFullNetworkRouting(routing)).toThrow('permutation');
  });
});

function pointInside(
  viewport: Readonly<{
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
  }>,
  x: number | undefined,
  y: number | undefined,
): boolean {
  return (
    x !== undefined &&
    y !== undefined &&
    x >= viewport.minX &&
    x <= viewport.maxX &&
    y >= viewport.minY &&
    y <= viewport.maxY
  );
}
