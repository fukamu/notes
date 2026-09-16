import { describe, expect, it } from 'vitest';
import {
  denseFullNetworkGraph,
  maximumUniqueLinksPerCardWithinPlaintextLimit,
  measureFullNetworkPlacement,
  numericGraphChecksum,
  placeFullNetwork,
  selectFullNetworkPlacementCandidate,
  semanticZoomFixtureCorpus,
} from '@/tests/benchmarks/full-network-semantic-zoom-support';

describe('full-network semantic zoom benchmark support', () => {
  it('derives the quota-valid unique link envelope from canonical plaintext bytes', () => {
    expect(maximumUniqueLinksPerCardWithinPlaintextLimit()).toEqual({
      links: 116,
      bytes: 8_169,
      nextBytes: 8_239,
    });
  });

  it('builds deterministic dense graphs with no self or duplicate edge per source', () => {
    const graph = denseFullNetworkGraph(32, 8);
    expect(graph.sources).toHaveLength(256);
    expect(graph.targets).toHaveLength(256);
    const edges = new Set<string>();
    for (let index = 0; index < graph.sources.length; index += 1) {
      const source = graph.sources[index];
      const target = graph.targets[index];
      expect(source).toBeDefined();
      expect(target).toBeDefined();
      expect(target).not.toBe(source);
      edges.add(`${source}:${target}`);
    }
    expect(edges).toHaveLength(256);
  });

  it('uses every edge deterministically while placing every node exactly once', () => {
    const graph = denseFullNetworkGraph(128, 4);
    const before = numericGraphChecksum(graph);
    const first = placeFullNetwork(graph, 'component-bfs-serpentine');
    const second = placeFullNetwork(graph, 'component-bfs-serpentine');
    expect([...second.x]).toEqual([...first.x]);
    expect([...second.y]).toEqual([...first.y]);
    expect(numericGraphChecksum(graph)).toBe(before);

    const metrics = measureFullNetworkPlacement(graph, first);
    expect(metrics.nodeCount).toBe(128);
    expect(metrics.edgeCount).toBe(512);
    expect(metrics.componentCount).toBe(1);
    expect(metrics.nonFiniteValues).toBe(0);
    expect(metrics.duplicatePositions).toBe(0);
    expect(metrics.maximumLinkLength).toBeGreaterThan(0);
  });

  it('selects a candidate by deterministic hard-geometry and worst-link priorities', () => {
    const graph = denseFullNetworkGraph(128, 16);
    const candidates = [
      'identity-serpentine',
      'component-bfs-serpentine',
      'component-dfs-serpentine',
    ] as const;
    const decision = selectFullNetworkPlacementCandidate(
      candidates.map((candidate) => ({
        graph: graph.name,
        metrics: measureFullNetworkPlacement(
          graph,
          placeFullNetwork(graph, candidate),
        ),
      })),
    );
    expect(decision.selected).toBe('component-bfs-serpentine');
    expect(decision.priority).toBe('worst-p95-link-length');
    expect(decision.scores).toHaveLength(3);
  });

  it('keeps isolated and disconnected components in the packed layout', () => {
    const graph = {
      name: 'disconnected',
      nodeCount: 6,
      sources: new Uint32Array([0, 2, 3]),
      targets: new Uint32Array([1, 3, 2]),
    };
    const placement = placeFullNetwork(graph, 'component-bfs-serpentine');
    const metrics = measureFullNetworkPlacement(graph, placement);
    expect(metrics.componentCount).toBe(4);
    expect(metrics.nodeCount).toBe(6);
    expect(metrics.edgeCount).toBe(3);
    expect(metrics.duplicatePositions).toBe(0);
  });

  it('keeps every required topology in the deterministic corpus', () => {
    const corpus = semanticZoomFixtureCorpus();
    expect(corpus.map((graph) => graph.name)).toEqual([
      'empty',
      'single',
      'all-isolated',
      'disconnected',
      'chain',
      'cycle',
      'self',
      'mutual',
      'star',
      'high-degree',
    ]);
    const highDegree = corpus.find((graph) => graph.name === 'high-degree');
    expect(highDegree?.nodeCount).toBe(10_000);
    expect(highDegree?.sources).toHaveLength(116);
    for (const graph of corpus) {
      const placement = placeFullNetwork(graph, 'component-bfs-serpentine');
      const metrics = measureFullNetworkPlacement(graph, placement);
      expect(metrics.nodeCount).toBe(graph.nodeCount);
      expect(metrics.edgeCount).toBe(graph.sources.length);
      expect(metrics.nonFiniteValues).toBe(0);
      expect(metrics.duplicatePositions).toBe(0);
    }
  });

  it('rejects invalid dense graph requests before allocating', () => {
    expect(() => denseFullNetworkGraph(0, 1)).toThrow(
      'An empty graph cannot contain links',
    );
    expect(() => denseFullNetworkGraph(4, 4)).toThrow(
      'linksPerNode must be smaller than nodeCount',
    );
  });
});
