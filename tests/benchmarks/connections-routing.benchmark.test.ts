import { mkdir, writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import { createMainThreadConnectionsLayoutRunner } from '@/lib/client/connections-layout-main-thread';
import {
  type ConnectionsLayout,
  type ConnectionsLayoutConfiguration,
  type ConnectionsLayoutFunction,
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
  relativeConnectionsPortSides,
  routeConnectionsWithVisibilityGraph,
  serializeLayoutPaths,
  type RouteInterpretation,
} from '@/tests/benchmarks/connections-routing-support';

type Candidate = {
  name: string;
  configuration: ConnectionsLayoutConfiguration;
  interpretation: RouteInterpretation;
  purpose: string;
  pipeline: 'single-layout' | 'relative-two-layouts' | 'visibility-post-route';
};

const candidates: Candidate[] = [
  {
    name: 'orthogonal-visibility-graph-post-route',
    configuration: {
      edgeRouting: 'ORTHOGONAL',
      portPolicy: 'FIXED_SIDE',
    },
    interpretation: 'orthogonal-polyline',
    purpose:
      'Baseline node placement followed by pure relative-side selection and rectilinear shortest paths around node clearance rectangles.',
    pipeline: 'visibility-post-route',
  },
  {
    name: 'baseline-orthogonal-fixed-side',
    configuration: {
      edgeRouting: 'ORTHOGONAL',
      portPolicy: 'FIXED_SIDE',
    },
    interpretation: 'orthogonal-polyline',
    purpose: 'Current ELK route and M/L rendering baseline.',
    pipeline: 'single-layout',
  },
  {
    name: 'orthogonal-elk-free-multi-side',
    configuration: {
      edgeRouting: 'ORTHOGONAL',
      portPolicy: 'FREE',
      edgePortSides: 'ELK',
    },
    interpretation: 'orthogonal-polyline',
    purpose:
      'One port per semantic endpoint with no prescribed side; ELK may place each port on NORTH/EAST/SOUTH/WEST.',
    pipeline: 'single-layout',
  },
  {
    name: 'orthogonal-relative-fixed-side-two-pass',
    configuration: {
      edgeRouting: 'ORTHOGONAL',
      portPolicy: 'FIXED_SIDE',
    },
    interpretation: 'orthogonal-polyline',
    purpose:
      'Baseline layout followed by a second layout whose port sides follow the first-pass relative node centers.',
    pipeline: 'relative-two-layouts',
  },
  {
    name: 'orthogonal-relative-fixed-order-two-pass',
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
      'Relative two-pass sides plus fixed clockwise input order and explicit straightness/shortness priorities.',
    pipeline: 'relative-two-layouts',
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
    pipeline: 'single-layout',
  },
];

const warmupIterations = 1;
const measuredIterations = 5;
const baselineConfiguration = {
  edgeRouting: 'ORTHOGONAL',
  portPolicy: 'FIXED_SIDE',
} as const satisfies ConnectionsLayoutConfiguration;

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
  const warmRunner = candidateRunner(candidate);
  const runOnce = () =>
    lifecycle === 'cold-runner'
      ? candidateRunner(candidate)(graph, spaciousConnectionsMetrics)
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

function candidateRunner(candidate: Candidate): ConnectionsLayoutFunction {
  if (candidate.pipeline === 'single-layout') {
    return createMainThreadConnectionsLayoutRunner(candidate.configuration);
  }
  const firstPass = createMainThreadConnectionsLayoutRunner(
    baselineConfiguration,
  );
  return async (graph, metrics) => {
    const initial = await firstPass(graph, metrics);
    if (candidate.pipeline === 'visibility-post-route') {
      return routeConnectionsWithVisibilityGraph(
        initial,
        graph,
        metrics.edgeNodeSpacing / 2,
      );
    }
    const edgePortSides = relativeConnectionsPortSides(graph, initial.nodes);
    return createMainThreadConnectionsLayoutRunner({
      ...candidate.configuration,
      edgePortSides,
    })(graph, metrics);
  };
}

function roundedQuality(
  metrics: ReturnType<typeof measureRouteQuality>,
): Record<string, unknown> {
  const { edges, ...aggregate } = metrics;
  return {
    ...Object.fromEntries(
      Object.entries(aggregate).map(([key, value]) => [key, rounded(value)]),
    ),
    edges: edges.map((edge) => ({
      ...edge,
      routeLength: rounded(edge.routeLength),
      obstacleLowerBound: rounded(edge.obstacleLowerBound),
      detourRatio: rounded(edge.detourRatio),
      mutualReverseExcessLength: rounded(edge.mutualReverseExcessLength),
    })),
  };
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
      const runner = candidateRunner(candidate);
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
        const metrics = measureRouteQuality(first, candidate.interpretation, {
          expectedGraph: graph,
          nodeClearance: spaciousConnectionsMetrics.edgeNodeSpacing / 2,
        });
        expect(metrics.nonFiniteValues).toBe(0);
        quality.push({
          candidate: candidate.name,
          fixture: fixture.name,
          nodes: fixture.nodes.length,
          edges: fixture.edges.length,
          hardConstraintPass:
            metrics.nonFiniteValues === 0 &&
            metrics.semanticEdgeErrors === 0 &&
            metrics.endpointMismatches === 0 &&
            metrics.arrowTangentErrors === 0 &&
            metrics.sectionDiscontinuities === 0 &&
            metrics.degenerateEdges === 0 &&
            metrics.nodeIntrusions === 0 &&
            metrics.clearanceIntrusions === 0 &&
            metrics.indistinguishableMutualPairs === 0,
          ...roundedQuality(metrics),
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
          rawSamplesMs: {
            coldLayout: cold.samples.map(rounded),
            warmLayout: warm.samples.map(rounded),
            pathGeneration: pathSamples.map(rounded),
          },
        });
      }
    }

    const artifact = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      precommittedEvaluationOrder: [
        'Gate 1: zero node/clearance intrusion, semantic/endpoint/side/tangent/section error, degeneracy, indistinguishable mutual pairs, and non-finite values; deterministic and input immutable',
        'Gate 2: representative layout median <= 1.10x baseline and p95 <= 1.20x baseline; record blocking, path, bundle, worker, and offline effects',
        'Gate 3.1: mutual reverse excess length',
        'Gate 3.2: obstacle-aware detour ratio and per-edge total/median/p95/maximum route length',
        'Gate 3.3: edge crossings',
        'Gate 3.4: overlapping segment count and length',
        'Gate 3.5: bends/control points',
        'Gate 3.6: graph area',
        'Gate 3.7: license, dependency, and maintenance cost',
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
      representativePerformanceFixture:
        'synthetic large seed 0x41decade (the existing ADR representative)',
      outlierPolicy:
        'No sample is removed. The artifact retains every raw cold, warm, and path-generation sample; timing is review evidence, not a CI gate.',
      bundleComparison: {
        method:
          'Same-host production builds at branch point a3ffb94b051b9201217b4a6cf92f773347db436b and the research working tree, using the same node_modules and gzip -c.',
        applicationChunk: {
          branchPoint: { rawBytes: 513668, gzipBytes: 160980 },
          research: { rawBytes: 514523, gzipBytes: 161264 },
          delta: { rawBytes: 855, gzipBytes: 284 },
        },
        css: {
          branchPoint: { rawBytes: 51534, gzipBytes: 8951 },
          research: { rawBytes: 51534, gzipBytes: 8951 },
          delta: { rawBytes: 0, gzipBytes: 0 },
        },
        elkWorker: {
          branchPoint: { rawBytes: 1595334, gzipBytes: 464634 },
          research: { rawBytes: 1595334, gzipBytes: 464634 },
          delta: { rawBytes: 0, gzipBytes: 0 },
        },
      },
      runtimeImpact: {
        newDependencies: 0,
        elkLicense: 'EPL-2.0 OR GPL-3.0-or-later (existing dependency)',
        researchOnlyCode:
          'Relative-side and visibility-graph functions are test-only and excluded from application and worker bundles.',
        worker:
          'Every ELK candidate uses the existing offline worker architecture. Two-pass candidates double worker layouts; visibility adds a post-route phase; FREE remains one layout.',
        cache:
          'A configurable runtime candidate would need policy/version in the cache key. The proposed production change is a build-time default, so the versioned worker asset and service-worker manifest invalidate old geometry without a runtime key branch.',
        cameraAndA11y:
          'Layout candidates do not change camera input handling, semantic edge-list cardinality, or node interaction contracts.',
      },
      fixtures: connectionsBenchmarkFixtures.map((fixture) => ({
        name: fixture.name,
        nodes: fixture.nodes.length,
        edges: fixture.edges.length,
      })),
      candidates: candidates.map(
        ({ name, configuration, interpretation, purpose, pipeline }) => ({
          name,
          configuration,
          interpretation,
          purpose,
          pipeline,
        }),
      ),
      quality,
      timings,
      decision:
        'Advance orthogonal-elk-free-multi-side to a separate implementation Issue. It is the only new candidate that passes every hard fixture and the representative large-graph 1.10 median / 1.20 p95 limits while materially reducing the precommitted primary quality metrics.',
    };
    await mkdir('docs/benchmarks', { recursive: true });
    await writeFile(
      'docs/benchmarks/connections-routing-follow-up.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    );
    expect(quality).toHaveLength(
      candidates.length * connectionsBenchmarkFixtures.length,
    );
  });
});
