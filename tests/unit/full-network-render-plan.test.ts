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
  createFullNetworkRenderDataset,
  createFullNetworkRenderPlan,
  defaultFullNetworkRenderConfiguration,
  fitFullNetworkRenderCamera,
  fullNetworkRendererGeometryBytes,
  queryFullNetworkNodes,
  selectFullNetworkSemanticLevel,
} from '@/lib/graph/full-network-render-plan';
import { createFullNetworkRouting } from '@/lib/graph/full-network-routing';
import { createClientPerformanceFixture } from '@/tests/fixtures/client-performance';
import { fixtureCardId } from '@/tests/fixtures/ids';

const ids = Array.from({ length: 12 }, (_, index) =>
  fixtureCardId(`full-render-plan-${index}`),
);

function id(index: number): CardId {
  const value = ids[index];
  if (value === undefined) throw new Error(`Missing fixture id ${index}`);
  return value;
}

function coordinate(values: Float32Array, index: number): number {
  const value = values[index];
  if (value === undefined) throw new Error(`Missing coordinate ${index}`);
  return value;
}

function input(
  edges: readonly (readonly [number, number])[],
): ConnectionsInputModel {
  return {
    currentCardId: id(0),
    nodes: ids.map((cardId, index) => ({
      cardId,
      displayLabel: `#${index + 1}`,
      title: `Card ${index + 1}`,
      accessibleName: `Card ${index + 1}`,
      current: index === 0,
    })),
    edges: edges.map(([source, target]) => ({
      sourceCardId: id(source),
      targetCardId: id(target),
      accessibleName: `${source} to ${target}`,
    })),
  };
}

function dataset(edges: readonly (readonly [number, number])[]) {
  const topology = createFullNetworkTopology(input(edges));
  const layout = layoutFullNetworkTopology(topology);
  const routing = createFullNetworkRouting(
    topology,
    layout,
    defaultFullNetworkLayoutConfiguration,
  );
  return createFullNetworkRenderDataset(routing);
}

describe('full-network semantic render plan', () => {
  it('builds retained geometry with one exact contribution for every node and edge', () => {
    const edges = [
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [2, 3],
      [4, 5],
    ] as const;
    const value = dataset(edges);

    expect(value.overview.nodeCount).toBe(ids.length);
    expect(value.overview.edgeCount).toBe(edges.length);
    expect(value.overview.nodePositions).toHaveLength(ids.length * 2);
    expect(value.overview.edgePositions).toHaveLength(edges.length * 4);
    for (const [edgeIndex, [source, target]] of edges.entries()) {
      expect(
        value.overview.edgePositions.slice(edgeIndex * 4, edgeIndex * 4 + 4),
      ).toEqual(
        new Float32Array([
          coordinate(value.routing.layout.x, source),
          coordinate(value.routing.layout.y, source),
          coordinate(value.routing.layout.x, target),
          coordinate(value.routing.layout.y, target),
        ]),
      );
    }
  });

  it('uses projected node size and hysteresis without changing graph membership', () => {
    const configuration = defaultFullNetworkRenderConfiguration;
    expect(selectFullNetworkSemanticLevel(1.9, 'overview')).toBe('overview');
    expect(selectFullNetworkSemanticLevel(3, 'overview')).toBe('network');
    expect(selectFullNetworkSemanticLevel(2.5, 'network')).toBe('network');
    expect(selectFullNetworkSemanticLevel(2, 'network')).toBe('overview');
    expect(selectFullNetworkSemanticLevel(24, 'network')).toBe('detail');
    expect(selectFullNetworkSemanticLevel(20, 'detail')).toBe('detail');
    expect(selectFullNetworkSemanticLevel(18, 'detail')).toBe('network');
    expect(() =>
      selectFullNetworkSemanticLevel(4, undefined, {
        ...configuration,
        networkToOverviewPixels: configuration.overviewToNetworkPixels,
      }),
    ).toThrow('hysteresis');
  });

  it('keeps every identity in overview and materializes only viewport detail', () => {
    const value = dataset([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 0],
      [2, 3],
      [4, 5],
      [5, 6],
    ]);
    const fit = fitFullNetworkRenderCamera({
      dataset: value,
      viewportWidth: 640,
      viewportHeight: 360,
      paddingPixels: 16,
    });
    const overview = createFullNetworkRenderPlan({
      dataset: value,
      camera: { ...fit, scale: 0.2 },
      currentCardId: id(0),
      selectedCardId: null,
      reducedMotion: false,
    });

    expect(overview.level).toBe('overview');
    expect(overview.overviewNodeCount).toBe(ids.length);
    expect(overview.overviewEdgeCount).toBe(7);
    expect(overview.visibleNodeIndexes).toHaveLength(0);
    expect(overview.visibleEdgeIndexes).toHaveLength(0);
    expect(overview.currentNodeIndex).toBe(0);
    expect(overview.selectedNodeIndex).toBeNull();
    expect([...overview.currentIncidentEdgeIndexes]).toEqual([0, 1, 2, 3]);
    expect(overview.selectedIncidentEdgeIndexes).toHaveLength(0);
    expect([...overview.emphasizedNodeIndexes]).toEqual([0]);
    expect([...overview.emphasizedEdgeIndexes]).toEqual([0, 1, 2, 3]);

    const firstX = value.routing.layout.x[0];
    const firstY = value.routing.layout.y[0];
    if (firstX === undefined || firstY === undefined) {
      throw new Error('Fixture omitted current node geometry');
    }
    const detail = createFullNetworkRenderPlan({
      dataset: value,
      camera: {
        offsetX: 320 - firstX * 8,
        offsetY: 180 - firstY * 8,
        scale: 8,
        viewportWidth: 640,
        viewportHeight: 360,
      },
      previousLevel: overview.level,
      currentCardId: id(0),
      selectedCardId: id(3),
      reducedMotion: false,
    });
    expect(detail.level).toBe('detail');
    expect(detail.transition).toEqual({
      kind: 'crossfade',
      from: 'overview',
      to: 'detail',
    });
    expect(detail.labelsVisible).toBe(true);
    expect(detail.directionsVisible).toBe(true);
    expect(detail.visibleNodeIndexes.length).toBeGreaterThan(0);
    expect(detail.visibleNodeIndexes.length).toBeLessThan(ids.length);
    expect(detail.overviewNodeCount).toBe(ids.length);
    expect(detail.overviewEdgeCount).toBe(7);
    expect([...detail.emphasizedNodeIndexes]).toEqual([0, 3]);
    expect(detail.currentNodeIndex).toBe(0);
    expect(detail.selectedNodeIndex).toBe(3);

    const reducedMotion = createFullNetworkRenderPlan({
      dataset: value,
      camera: detail.camera,
      previousLevel: 'overview',
      currentCardId: id(0),
      reducedMotion: true,
    });
    expect(reducedMotion.transition.kind).toBe('cut');
    expect(reducedMotion.planKey).not.toBe(detail.planKey);

    const reversedEmphasis = createFullNetworkRenderPlan({
      dataset: value,
      camera: detail.camera,
      previousLevel: 'overview',
      currentCardId: id(3),
      selectedCardId: id(0),
      reducedMotion: false,
    });
    expect(reversedEmphasis.emphasizedNodeIndexes).toEqual(
      detail.emphasizedNodeIndexes,
    );
    expect(reversedEmphasis.planKey).not.toBe(detail.planKey);
  });

  it('queries node rectangles at viewport boundaries without duplicate DOM candidates', () => {
    const value = dataset([
      [0, 1],
      [2, 3],
    ]);
    const x = value.routing.layout.x[0];
    const y = value.routing.layout.y[0];
    if (x === undefined || y === undefined) {
      throw new Error('Fixture omitted first node geometry');
    }
    const halfWidth = value.routing.routingConfiguration.nodeHalfWidth;
    const halfHeight = value.routing.routingConfiguration.nodeHalfHeight;
    expect([
      ...queryFullNetworkNodes(value, {
        minX: x + halfWidth,
        minY: y - halfHeight,
        maxX: x + halfWidth,
        maxY: y + halfHeight,
      }),
    ]).toContain(0);
    expect(
      queryFullNetworkNodes(value, {
        minX: value.routing.layout.width + 100,
        minY: value.routing.layout.height + 100,
        maxX: value.routing.layout.width + 101,
        maxY: value.routing.layout.height + 101,
      }),
    ).toHaveLength(0);
  });

  it('keeps 10k retained geometry O(V + E) and reports every buffer separately', () => {
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
    const value = createFullNetworkRenderDataset(routing);
    const bytes = fullNetworkRendererGeometryBytes(value);

    expect(value.overview.nodeCount).toBe(10_000);
    expect(value.overview.edgeCount).toBe(19_951);
    expect(bytes.overviewEdgePositions).toBe(19_951 * 16);
    expect(bytes.overviewNodePositions).toBe(10_000 * 8);
    expect(bytes.nodeSpatialIndex).toBe(10_000 * 4);
    expect(bytes.incidentOffsets).toBe(10_001 * 4);
    expect(bytes.incidentEdgeIndexes).toBe(19_951 * 2 * 4);
    expect(bytes.total).toBe(
      bytes.overviewEdgePositions +
        bytes.overviewNodePositions +
        bytes.nodeSpatialIndex +
        bytes.incidentOffsets +
        bytes.incidentEdgeIndexes,
    );
  });

  it('rejects malformed cameras before a viewport query can corrupt rendering', () => {
    const value = dataset([[0, 1]]);
    expect(() =>
      createFullNetworkRenderPlan({
        dataset: value,
        camera: {
          offsetX: 0,
          offsetY: 0,
          scale: Number.NaN,
          viewportWidth: 640,
          viewportHeight: 360,
        },
        reducedMotion: false,
      }),
    ).toThrow('camera.scale');
  });
});
