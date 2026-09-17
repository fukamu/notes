import { describe, expect, it } from 'vitest';
import { buildConnectionsGraph } from '@/lib/domain/graph';
import type { CardId } from '@/lib/domain/id';
import { layoutConnectionsCorridors } from '@/lib/graph/connections-corridor-layout';
import type {
  ConnectionsLayout,
  ConnectionsLayoutGraph,
  ConnectionsLayoutNode,
  LayoutPoint,
} from '@/lib/graph/elk-layout';
import { createConnectionsSvgPath } from '@/lib/graph/connections-path';
import { invariant } from '@/lib/shared/invariant';
import { createFullNetworkBaselineFixture } from '@/tests/fixtures/connections-full-network';
import { fixtureCardId } from '@/tests/fixtures/ids';

const metrics = {
  nodeWidth: 196,
  nodeHeight: 72,
  portSize: 2,
  componentSpacing: 96,
  nodeSpacing: 72,
  edgeNodeSpacing: 32,
  layerSpacing: 112,
  edgeLayerSpacing: 40,
  padding: { top: 24, right: 24, bottom: 24, left: 24 },
} as const;

const options = { laneSpacing: 8 } as const;
const largeLayoutTimeoutMs = 20_000;

function graphFromFixture(name: string): ConnectionsLayoutGraph {
  const fixture = createFullNetworkBaselineFixture(name);
  const graph = buildConnectionsGraph(fixture.cards);
  return {
    nodes: graph.nodes.map(({ card }) => ({ id: card.id })),
    edges: graph.edges,
  };
}

function smallGraph(
  name: string,
  labels: readonly string[],
  edgeLabels: readonly (readonly [string, string])[],
): ConnectionsLayoutGraph {
  const idByLabel = new Map<string, CardId>(
    labels.map((label) => [label, fixtureCardId(`${name}-${label}`)]),
  );
  return {
    nodes: labels.map((label) => {
      const id = idByLabel.get(label);
      invariant(id, `Missing fixture node ${label}`);
      return { id };
    }),
    edges: edgeLabels.map(([sourceLabel, targetLabel]) => {
      const sourceCardId = idByLabel.get(sourceLabel);
      const targetCardId = idByLabel.get(targetLabel);
      invariant(sourceCardId, `Missing fixture source ${sourceLabel}`);
      invariant(targetCardId, `Missing fixture target ${targetLabel}`);
      return { sourceCardId, targetCardId };
    }),
  };
}

function edgePoints(layout: ConnectionsLayout, edgeIndex: number) {
  const edge = layout.edges[edgeIndex];
  invariant(edge, `Missing layout edge ${edgeIndex}`);
  const section = edge.sections[0];
  invariant(section, `Missing layout section ${edgeIndex}`);
  return [section.startPoint, ...section.bendPoints, section.endPoint];
}

function expectFiniteCompleteLayout(
  graph: ConnectionsLayoutGraph,
  layout: ConnectionsLayout,
): void {
  if (
    !Number.isFinite(layout.width) ||
    !Number.isFinite(layout.height) ||
    layout.width <= 0 ||
    layout.height <= 0
  ) {
    throw new Error('Layout has invalid bounds');
  }
  if (layout.nodes.length !== graph.nodes.length) {
    throw new Error('Layout changed the node count');
  }
  if (layout.edges.length !== graph.edges.length) {
    throw new Error('Layout changed the edge count');
  }

  const ports = new Map(
    layout.nodes.flatMap((node) =>
      node.ports.map((port) => [port.id, { node, port }] as const),
    ),
  );
  if (ports.size !== graph.edges.length * 2) {
    throw new Error('Layout did not return two independent ports per edge');
  }
  for (const [nodeIndex, node] of layout.nodes.entries()) {
    if (node.id !== graph.nodes[nodeIndex]?.id) {
      throw new Error(`Layout changed node order at ${nodeIndex}`);
    }
    if (
      node.width !== metrics.nodeWidth ||
      node.height !== metrics.nodeHeight ||
      node.x < 0 ||
      node.y < 0 ||
      node.x + node.width > layout.width ||
      node.y + node.height > layout.height
    ) {
      throw new Error(`Layout returned invalid node geometry at ${nodeIndex}`);
    }
    for (const port of node.ports) {
      if (
        (port.side !== 'NORTH' && port.side !== 'SOUTH') ||
        ![port.x, port.y, port.width, port.height].every(Number.isFinite)
      ) {
        throw new Error(`Layout returned invalid port ${port.id}`);
      }
    }
  }

  for (const [edgeIndex, edge] of layout.edges.entries()) {
    const inputEdge = graph.edges[edgeIndex];
    invariant(inputEdge, `Missing input edge ${edgeIndex}`);
    if (
      edge.sourceCardId !== inputEdge.sourceCardId ||
      edge.targetCardId !== inputEdge.targetCardId ||
      edge.id !== `edge-${edgeIndex}` ||
      edge.sourcePortId !== `port-${edgeIndex}-source` ||
      edge.targetPortId !== `port-${edgeIndex}-target`
    ) {
      throw new Error(`Layout changed edge order or identity at ${edgeIndex}`);
    }
    const source = ports.get(edge.sourcePortId);
    const target = ports.get(edge.targetPortId);
    invariant(source, `Missing source port ${edge.sourcePortId}`);
    invariant(target, `Missing target port ${edge.targetPortId}`);
    if (
      source.node.id !== edge.sourceCardId ||
      target.node.id !== edge.targetCardId
    ) {
      throw new Error(`Layout attached edge ${edgeIndex} to the wrong node`);
    }
    if (edge.sections.length !== 1) {
      throw new Error(`Layout split edge ${edgeIndex} into multiple sections`);
    }
    const section = edge.sections[0];
    invariant(section, `Missing section ${edgeIndex}`);
    if (
      section.id !== `edge-${edgeIndex}-section-0` ||
      section.incomingShape !== edge.sourcePortId ||
      section.outgoingShape !== edge.targetPortId
    ) {
      throw new Error(
        `Layout returned invalid section identity at ${edgeIndex}`,
      );
    }
    const points = edgePoints(layout, edgeIndex);
    if (points.length < 2 || points.length > 6) {
      throw new Error(
        `Layout returned ${points.length} points for edge ${edgeIndex}`,
      );
    }
    for (const [pointIndex, point] of points.entries()) {
      if (
        !Number.isFinite(point.x) ||
        !Number.isFinite(point.y) ||
        point.x < 0 ||
        point.y < 0 ||
        point.x > layout.width ||
        point.y > layout.height
      ) {
        throw new Error(
          `Layout returned invalid point ${pointIndex} for edge ${edgeIndex}`,
        );
      }
      const previous = points[pointIndex - 1];
      if (previous) {
        if (
          (previous.x !== point.x && previous.y !== point.y) ||
          (previous.x === point.x && previous.y === point.y)
        ) {
          throw new Error(`Layout returned a non-orthogonal edge ${edgeIndex}`);
        }
      }
    }
    const path = createConnectionsSvgPath(section, {
      maximumRadius: 16,
      nodeClearance: metrics.edgeNodeSpacing,
    });
    if (
      /NaN|Infinity/.test(path.d) ||
      path.startPoint.x !== section.startPoint.x ||
      path.startPoint.y !== section.startPoint.y ||
      path.endPoint.x !== section.endPoint.x ||
      path.endPoint.y !== section.endPoint.y
    ) {
      throw new Error(`Curve generation changed edge ${edgeIndex}`);
    }
  }
}

function bucketRange(start: number, end: number, size: number): number[] {
  const first = Math.floor(start / size);
  const last = Math.floor(end / size);
  return Array.from({ length: last - first + 1 }, (_, index) => first + index);
}

function addBucket(
  buckets: Map<number, ConnectionsLayoutNode[]>,
  key: number,
  node: ConnectionsLayoutNode,
): void {
  const bucket = buckets.get(key);
  if (bucket) bucket.push(node);
  else buckets.set(key, [node]);
}

function expectNodeSafeCurves(layout: ConnectionsLayout): void {
  const xBucketSize = metrics.nodeWidth;
  const yBucketSize = metrics.nodeHeight;
  const xBuckets = new Map<number, ConnectionsLayoutNode[]>();
  const yBuckets = new Map<number, ConnectionsLayoutNode[]>();
  const cellSize = Math.max(metrics.nodeWidth, metrics.nodeHeight);
  const cells = new Map<string, ConnectionsLayoutNode[]>();
  for (const node of layout.nodes) {
    for (const key of bucketRange(node.x, node.x + node.width, xBucketSize)) {
      addBucket(xBuckets, key, node);
    }
    for (const key of bucketRange(node.y, node.y + node.height, yBucketSize)) {
      addBucket(yBuckets, key, node);
    }
    for (const x of bucketRange(node.x, node.x + node.width, cellSize)) {
      for (const y of bucketRange(node.y, node.y + node.height, cellSize)) {
        const key = `${x}:${y}`;
        const bucket = cells.get(key);
        if (bucket) bucket.push(node);
        else cells.set(key, [node]);
      }
    }
  }

  const epsilon = 1e-7;
  const intersectsInterior = (
    bounds: Readonly<{
      left: number;
      top: number;
      right: number;
      bottom: number;
    }>,
    node: ConnectionsLayoutNode,
  ) =>
    bounds.right > node.x + epsilon &&
    bounds.left < node.x + node.width - epsilon &&
    bounds.bottom > node.y + epsilon &&
    bounds.top < node.y + node.height - epsilon;

  for (const edge of layout.edges) {
    for (const section of edge.sections) {
      const path = createConnectionsSvgPath(section, {
        maximumRadius: 16,
        nodeClearance: metrics.edgeNodeSpacing,
      });
      for (const segment of path.segments) {
        const points: readonly LayoutPoint[] =
          segment.kind === 'quadratic'
            ? [segment.start, segment.control, segment.end]
            : [segment.start, segment.end];
        const xs = points.map(({ x }) => x);
        const ys = points.map(({ y }) => y);
        const bounds = {
          left: Math.min(...xs),
          top: Math.min(...ys),
          right: Math.max(...xs),
          bottom: Math.max(...ys),
        };
        let candidates: readonly ConnectionsLayoutNode[];
        if (segment.kind === 'line' && segment.start.y === segment.end.y) {
          candidates =
            yBuckets.get(Math.floor(segment.start.y / yBucketSize)) ?? [];
        } else if (
          segment.kind === 'line' &&
          segment.start.x === segment.end.x
        ) {
          candidates =
            xBuckets.get(Math.floor(segment.start.x / xBucketSize)) ?? [];
        } else {
          const found = new Set<ConnectionsLayoutNode>();
          for (const x of bucketRange(bounds.left, bounds.right, cellSize)) {
            for (const y of bucketRange(bounds.top, bounds.bottom, cellSize)) {
              for (const node of cells.get(`${x}:${y}`) ?? []) found.add(node);
            }
          }
          candidates = [...found];
        }
        for (const node of candidates) {
          if (intersectsInterior(bounds, node)) {
            throw new Error(`Curved edge ${edge.id} enters node ${node.id}`);
          }
        }
      }
    }
  }
}

describe('connections corridor layout', () => {
  it('is deterministic, preserves caller input, and returns original input order', () => {
    const graph = smallGraph(
      'ordered',
      ['C', 'A', 'isolated', 'B'],
      [
        ['B', 'A'],
        ['A', 'C'],
      ],
    );
    const snapshot = structuredClone(graph);

    const first = layoutConnectionsCorridors(graph, metrics, options);
    const second = layoutConnectionsCorridors(graph, metrics, options);

    expect(graph).toEqual(snapshot);
    expect(first).toEqual(second);
    expectFiniteCompleteLayout(graph, first);
    expectNodeSafeCurves(first);
  });

  it('keeps self and mutual references distinct with independent ports', () => {
    const graph = smallGraph(
      'loops',
      ['A', 'B'],
      [
        ['A', 'A'],
        ['A', 'B'],
        ['B', 'A'],
      ],
    );
    const layout = layoutConnectionsCorridors(graph, metrics, options);
    expectFiniteCompleteLayout(graph, layout);
    expectNodeSafeCurves(layout);
    const signatures = layout.edges.map((_, index) =>
      JSON.stringify(edgePoints(layout, index)),
    );
    expect(new Set(signatures).size).toBe(signatures.length);
    expect(edgePoints(layout, 0).length).toBeGreaterThanOrEqual(4);
  });

  it('returns padding-only empty geometry and rejects invalid boundaries', () => {
    expect(
      layoutConnectionsCorridors({ nodes: [], edges: [] }, metrics, options),
    ).toEqual({
      width: metrics.padding.left + metrics.padding.right,
      height: metrics.padding.top + metrics.padding.bottom,
      nodes: [],
      edges: [],
    });
    const id = fixtureCardId('invalid-only');
    const missing = fixtureCardId('invalid-missing');
    expect(() =>
      layoutConnectionsCorridors(
        {
          nodes: [{ id }],
          edges: [{ sourceCardId: id, targetCardId: missing }],
        },
        metrics,
        options,
      ),
    ).toThrow('missing target');
    expect(() =>
      layoutConnectionsCorridors(
        { nodes: [{ id }, { id }], edges: [] },
        metrics,
        options,
      ),
    ).toThrow('duplicate node');
    expect(() =>
      layoutConnectionsCorridors({ nodes: [{ id }], edges: [] }, metrics, {
        laneSpacing: 0,
      }),
    ).toThrow('laneSpacing must be positive');
  });

  it.each([
    'boundary-257-mixed',
    'representative-1000-e3000-mixed',
    'product-10000-existing',
    'connected-10000-e20000',
  ])(
    'returns complete, finite, node-safe geometry for %s',
    (fixtureName) => {
      const graph = graphFromFixture(fixtureName);
      const layout = layoutConnectionsCorridors(graph, metrics, options);

      expectFiniteCompleteLayout(graph, layout);
      expectNodeSafeCurves(layout);
    },
    largeLayoutTimeoutMs,
  );
});
