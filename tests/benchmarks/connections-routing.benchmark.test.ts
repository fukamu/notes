import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  createConnectionsLayoutRunner,
  type ConnectionsLayout,
  type ConnectionsLayoutConfiguration,
} from '@/lib/graph/elk-layout';
import { invariant } from '@/lib/shared/invariant';
import {
  connectionsBenchmarkFixtures,
  connectionsFixtureGraph,
  spaciousConnectionsMetrics,
} from '@/tests/fixtures/connections-layout';
import {
  distribution,
  measureRouteQuality,
  serializeLayoutPaths,
  type RouteInterpretation,
} from '@/tests/benchmarks/connections-routing-support';

type Candidate = {
  name: string;
  configuration: ConnectionsLayoutConfiguration;
  interpretation: RouteInterpretation;
  purpose: string;
};

const candidates: Candidate[] = [
  {
    name: 'baseline-orthogonal-fixed-side',
    configuration: {
      edgeRouting: 'ORTHOGONAL',
      portPolicy: 'FIXED_SIDE',
    },
    interpretation: 'orthogonal-polyline',
    purpose: 'Current ELK route and M/L rendering baseline.',
  },
  {
    name: 'orthogonal-safe-rounded',
    configuration: {
      edgeRouting: 'ORTHOGONAL',
      portPolicy: 'FIXED_SIDE',
    },
    interpretation: 'orthogonal-rounded',
    purpose:
      'Current route with quadratic corners clamped by adjacent segments and sampled node clearance.',
  },
  {
    name: 'orthogonal-fixed-order-priorities',
    configuration: {
      edgeRouting: 'ORTHOGONAL',
      portPolicy: 'FIXED_ORDER',
      addUnnecessaryBendpoints: false,
      favorStraightEdges: true,
      straightnessPriority: 8,
      shortnessPriority: 8,
    },
    interpretation: 'orthogonal-polyline',
    purpose:
      'Alternative port order plus explicit straightness, shortness, and unnecessary-bend policy.',
  },
  {
    name: 'splines-conservative-fixed-side',
    configuration: {
      edgeRouting: 'SPLINES',
      portPolicy: 'FIXED_SIDE',
      splineRoutingMode: 'CONSERVATIVE',
      addUnnecessaryBendpoints: false,
    },
    interpretation: 'spline-cubic',
    purpose:
      'ELK piecewise cubic controls with the node-avoiding conservative routing mode.',
  },
];

const warmupIterations = 1;
const measuredIterations = 5;

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function roundedDistribution(samples: number[]) {
  const measured = distribution(samples);
  return {
    medianMs: rounded(measured.median),
    p95Ms: rounded(measured.p95),
    minimumMs: rounded(measured.minimum),
    maximumMs: rounded(measured.maximum),
  };
}

async function timedLayout(
  candidate: Candidate,
  fixtureName: string,
  lifecycle: 'cold-runner' | 'warm-runner',
) {
  const fixture = connectionsBenchmarkFixtures.find(
    ({ name }) => name === fixtureName,
  );
  invariant(fixture, `Missing timing fixture ${fixtureName}`);
  const graph = connectionsFixtureGraph(fixture);
  const warmRunner = createConnectionsLayoutRunner(candidate.configuration);
  const runOnce = () =>
    lifecycle === 'cold-runner'
      ? createConnectionsLayoutRunner(candidate.configuration)(
          graph,
          spaciousConnectionsMetrics,
        )
      : warmRunner(graph, spaciousConnectionsMetrics);
  for (let index = 0; index < warmupIterations; index += 1) await runOnce();
  const samples: number[] = [];
  let lastLayout: ConnectionsLayout | null = null;
  for (let index = 0; index < measuredIterations; index += 1) {
    const started = performance.now();
    lastLayout = await runOnce();
    samples.push(performance.now() - started);
  }
  invariant(lastLayout, 'Timing did not produce a layout');
  return { samples, lastLayout };
}

function timedPathGeneration(
  layout: ConnectionsLayout,
  interpretation: RouteInterpretation,
) {
  for (let index = 0; index < 20; index += 1) {
    serializeLayoutPaths(layout, interpretation);
  }
  const samples: number[] = [];
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    serializeLayoutPaths(layout, interpretation);
    samples.push(performance.now() - started);
  }
  return samples;
}

describe('connections routing benchmark artifact', () => {
  it('measures the fixed corpus and writes reproducible comparison data', async () => {
    const quality = [];
    for (const candidate of candidates) {
      const runner = createConnectionsLayoutRunner(candidate.configuration);
      for (const fixture of connectionsBenchmarkFixtures) {
        console.info(`quality ${candidate.name}: ${fixture.name}`);
        const graph = connectionsFixtureGraph(fixture);
        const inputSnapshot = JSON.stringify(graph);
        const first = await runner(graph, spaciousConnectionsMetrics);
        const second = await runner(graph, spaciousConnectionsMetrics);
        expect(second).toEqual(first);
        expect(JSON.stringify(graph)).toBe(inputSnapshot);
        expect(first.nodes).toHaveLength(graph.nodes.length);
        expect(first.edges).toHaveLength(graph.edges.length);
        const metrics = measureRouteQuality(first, candidate.interpretation);
        expect(metrics.nonFiniteValues).toBe(0);
        expect(metrics.endpointMismatches).toBe(0);
        expect(metrics.sectionDiscontinuities).toBe(0);
        quality.push({
          candidate: candidate.name,
          fixture: fixture.name,
          nodes: fixture.nodes.length,
          edges: fixture.edges.length,
          ...Object.fromEntries(
            Object.entries(metrics).map(([key, value]) => [
              key,
              rounded(value),
            ]),
          ),
        });
      }
    }

    const timings = [];
    for (const candidate of candidates) {
      for (const fixtureName of [
        'synthetic medium seed 0x41c0ffee',
        'synthetic large seed 0x41decade',
      ]) {
        console.info(`timing ${candidate.name}: ${fixtureName}`);
        const cold = await timedLayout(candidate, fixtureName, 'cold-runner');
        const warm = await timedLayout(candidate, fixtureName, 'warm-runner');
        const pathSamples = timedPathGeneration(
          warm.lastLayout,
          candidate.interpretation,
        );
        const coldDistribution = distribution(cold.samples);
        const warmDistribution = distribution(warm.samples);
        const pathDistribution = distribution(pathSamples);
        timings.push({
          candidate: candidate.name,
          fixture: fixtureName,
          coldLayout: roundedDistribution(cold.samples),
          warmLayout: roundedDistribution(warm.samples),
          pathGeneration: roundedDistribution(pathSamples),
          timeToReadyProxyMedianMs: rounded(
            warmDistribution.median + pathDistribution.median,
          ),
          blockingProxy: {
            samplesOver50Ms: [...cold.samples, ...warm.samples].filter(
              (sample) => sample > 50,
            ).length,
            maximumMs: rounded(
              Math.max(coldDistribution.maximum, warmDistribution.maximum),
            ),
            note: 'Single-call Node main-thread proxy; browser long-task and gesture measurements are recorded with the viewport implementation.',
          },
        });
      }
    }

    const artifact = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      evaluationOrder: [
        'nodeIntrusions (hard constraint)',
        'semantic edge and endpoint correctness',
        'edgeCrossings',
        'overlappingSegments and overlappingLength',
        'totalRouteLength',
        'bendOrControlPointCount',
        'graphBoundingArea',
        'cold/warm layout median and p95',
        'path generation and time-to-ready proxy',
        'main-thread blocking proxy',
        'bundle size',
      ],
      environment: {
        node: process.version,
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        elkjs: '0.12.0',
        nodeWidth: spaciousConnectionsMetrics.nodeWidth,
        nodeHeight: spaciousConnectionsMetrics.nodeHeight,
        warmupIterations,
        measuredIterations,
        curveSamplingSteps: 12,
      },
      fixtures: connectionsBenchmarkFixtures.map((fixture) => ({
        name: fixture.name,
        nodes: fixture.nodes.length,
        edges: fixture.edges.length,
      })),
      candidates: candidates.map(
        ({ name, configuration, interpretation, purpose }) => ({
          name,
          configuration,
          interpretation,
          purpose,
        }),
      ),
      quality,
      timings,
    };
    await mkdir('docs/benchmarks', { recursive: true });
    await writeFile(
      'docs/benchmarks/connections-routing-baseline.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    );
    expect(quality).toHaveLength(
      candidates.length * connectionsBenchmarkFixtures.length,
    );
  });
});
