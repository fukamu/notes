import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release, totalmem } from 'node:os';
import { describe, expect, it } from 'vitest';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import {
  createFullNetworkTopology,
  createFullNetworkTopologyFromNumeric,
  layoutFullNetworkTopology,
  type FullNetworkLayout,
  type FullNetworkTopology,
} from '@/lib/graph/full-network-layout';
import {
  denseFullNetworkGraph,
  maximumUniqueLinksPerCardWithinPlaintextLimit,
  measureFullNetworkPlacement,
  placeFullNetwork,
  representativeFullNetworkGraph,
  type FullNetworkNumericGraph,
  type FullNetworkPlacement,
} from '@/tests/benchmarks/full-network-semantic-zoom-support';
import { createClientPerformanceFixture } from '@/tests/fixtures/client-performance';
import { fixtureCardId } from '@/tests/fixtures/ids';

const branchPoint = 'd4a915ed1f5fad86d4f0c6f0caf6bbdbc029bb4e';
const measuredIterations = 3;

function rounded(value: number): number {
  return Number(value.toFixed(3));
}

function timing(samples: readonly number[]) {
  const sorted = [...samples].sort((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  if (median === undefined || p95 === undefined) {
    throw new Error('Organic wiring benchmark omitted timing samples');
  }
  return {
    measuredIterations: samples.length,
    medianMs: rounded(median),
    p95Ms: rounded(p95),
    samplesMs: samples.map(rounded),
  };
}

function coordinateConcentration(
  x: Float64Array | Float32Array,
  y: Float64Array | Float32Array,
) {
  const xCounts = new Map<number, number>();
  const yCounts = new Map<number, number>();
  for (let node = 0; node < x.length; node += 1) {
    const nodeX = x[node];
    const nodeY = y[node];
    if (nodeX === undefined || nodeY === undefined) {
      throw new Error(`Organic wiring benchmark omitted node ${node}`);
    }
    xCounts.set(nodeX, (xCounts.get(nodeX) ?? 0) + 1);
    yCounts.set(nodeY, (yCounts.get(nodeY) ?? 0) + 1);
  }
  return {
    uniqueX: xCounts.size,
    uniqueY: yCounts.size,
    maximumNodesSharingX: Math.max(0, ...xCounts.values()),
    maximumNodesSharingY: Math.max(0, ...yCounts.values()),
  };
}

function measuredGeometry(
  graph: FullNetworkNumericGraph,
  placement: FullNetworkPlacement,
) {
  const { candidate: _candidate, ...metrics } = measureFullNetworkPlacement(
    graph,
    placement,
  );
  return {
    ...metrics,
    coordinateConcentration: coordinateConcentration(placement.x, placement.y),
  };
}

function productionPlacement(layout: FullNetworkLayout): FullNetworkPlacement {
  return {
    candidate: 'component-bfs-serpentine',
    x: Float64Array.from(layout.x),
    y: Float64Array.from(layout.y),
    width: layout.width,
    height: layout.height,
    componentCount: layout.components.length,
  };
}

function sortedDenseTopology(
  graph: FullNetworkNumericGraph,
): FullNetworkTopology {
  const sources = new Uint32Array(graph.sources.length);
  const targets = new Uint32Array(graph.targets.length);
  const targetsBySource = Array.from(
    { length: graph.nodeCount },
    (): number[] => [],
  );
  for (let edge = 0; edge < graph.sources.length; edge += 1) {
    const source = graph.sources[edge];
    const target = graph.targets[edge];
    if (source === undefined || target === undefined) {
      throw new Error(`Dense edge ${edge} vanished`);
    }
    const sourceTargets = targetsBySource[source];
    if (!sourceTargets) throw new Error(`Dense source ${source} vanished`);
    sourceTargets.push(target);
  }
  let output = 0;
  for (let source = 0; source < graph.nodeCount; source += 1) {
    const sourceTargets = targetsBySource[source];
    if (!sourceTargets) throw new Error(`Dense source ${source} vanished`);
    sourceTargets.sort((left, right) => left - right);
    for (const target of sourceTargets) {
      sources[output] = source;
      targets[output] = target;
      output += 1;
    }
  }
  if (output !== graph.sources.length) {
    throw new Error('Dense topology sorting omitted edges');
  }
  return createFullNetworkTopologyFromNumeric(
    Array.from({ length: graph.nodeCount }, (_, index) =>
      fixtureCardId(`organic-wiring-${index}`),
    ),
    sources,
    targets,
  );
}

function measureProduction(
  graph: FullNetworkNumericGraph,
  topology: FullNetworkTopology,
) {
  const samples: number[] = [];
  let layout = layoutFullNetworkTopology(topology);
  for (let iteration = 0; iteration < measuredIterations; iteration += 1) {
    const started = performance.now();
    layout = layoutFullNetworkTopology(topology);
    samples.push(performance.now() - started);
  }
  return {
    algorithm: 'component-bfs-warped-v2',
    timing: timing(samples),
    geometry: measuredGeometry(graph, productionPlacement(layout)),
  };
}

function measureBaseline(graph: FullNetworkNumericGraph) {
  const samples: number[] = [];
  let placement = placeFullNetwork(graph, 'component-bfs-serpentine');
  for (let iteration = 0; iteration < measuredIterations; iteration += 1) {
    const started = performance.now();
    placement = placeFullNetwork(graph, 'component-bfs-serpentine');
    samples.push(performance.now() - started);
  }
  return {
    algorithm: 'component-bfs-serpentine-v1',
    timing: timing(samples),
    geometry: measuredGeometry(graph, placement),
  };
}

describe('full-network organic wiring benchmark evidence', () => {
  it('compares the production bounded-warp layout with its exact serpentine baseline', async () => {
    const cards = createClientPerformanceFixture();
    const current = cards[5_000];
    if (!current)
      throw new Error('Representative fixture omitted current card');
    const representativeGraph = representativeFullNetworkGraph(cards);
    const representativeTopology = createFullNetworkTopology(
      selectConnectionsViewModel(cards, current.id),
    );
    const linkEnvelope = maximumUniqueLinksPerCardWithinPlaintextLimit();
    const denseGraph = denseFullNetworkGraph(10_000, linkEnvelope.links);
    const denseTopology = sortedDenseTopology(denseGraph);

    expect(representativeTopology.nodeIds).toHaveLength(10_000);
    expect(representativeTopology.sources).toHaveLength(19_951);
    expect(denseTopology.nodeIds).toHaveLength(10_000);
    expect(denseTopology.sources).toHaveLength(1_160_000);

    const graphs = [
      {
        name: representativeGraph.name,
        nodeCount: representativeGraph.nodeCount,
        edgeCount: representativeGraph.sources.length,
        baseline: measureBaseline(representativeGraph),
        production: measureProduction(
          representativeGraph,
          representativeTopology,
        ),
      },
      {
        name: denseGraph.name,
        nodeCount: denseGraph.nodeCount,
        edgeCount: denseGraph.sources.length,
        baseline: measureBaseline(denseGraph),
        production: measureProduction(denseGraph, denseTopology),
      },
    ];
    for (const graph of graphs) {
      expect(graph.production.geometry.nodeCount).toBe(graph.nodeCount);
      expect(graph.production.geometry.edgeCount).toBe(graph.edgeCount);
      expect(graph.production.geometry.nonFiniteValues).toBe(0);
      expect(graph.production.geometry.duplicatePositions).toBe(0);
      expect(
        graph.production.geometry.coordinateConcentration.uniqueX,
      ).toBeGreaterThan(
        graph.baseline.geometry.coordinateConcentration.uniqueX,
      );
      expect(
        graph.production.geometry.coordinateConcentration.uniqueY,
      ).toBeGreaterThan(
        graph.baseline.geometry.coordinateConcentration.uniqueY,
      );
    }

    const artifact = {
      schemaVersion: 1,
      issue: 301,
      branchPoint,
      generatedAt: new Date().toISOString(),
      host: {
        platform: platform(),
        release: release(),
        cpuModel: cpus()[0]?.model ?? 'unknown',
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        node: process.version,
      },
      policy: {
        timing: 'raw evidence only; no host-dependent pass/fail threshold',
        displaySampling: false,
        coordinateConcentration:
          'exact equality of Float32/Float64 node coordinates',
      },
      graphs,
      retainedGeometryBytes: {
        representative: 19_951 * 16 + 10_000 * 8,
        dense: 1_160_000 * 16 + 10_000 * 8,
        changedFromBaseline: false,
      },
    };
    await mkdir('docs/benchmarks', { recursive: true });
    await writeFile(
      'docs/benchmarks/full-network-organic-wiring.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    );
  }, 600_000);
});
