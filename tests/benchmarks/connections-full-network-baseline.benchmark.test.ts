import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { cpus, platform, release, tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultConnectionsPresentation } from '@/components/connections-presentation';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import type { CardRecord } from '@/lib/domain/types';
import { reconcileVisibleCardsAfterSync } from '@/lib/sync/client-reconciliation';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  connectionsLayoutKey,
  createConnectionsController,
  type ConnectionsLayoutRunner,
} from '@/lib/graph/connections-controller';
import type {
  ConnectionsLayout,
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';
import { invariant } from '@/lib/shared/invariant';
import {
  connectionsLayoutGraph,
  decodeIsolatedFullNetworkLayoutResult,
  fullNetworkGraphShape,
  measureOperation,
  type FullNetworkLayoutMode,
} from '@/tests/benchmarks/connections-full-network-baseline-support';
import { summarizeClientBenchmarkSamples } from '@/tests/benchmarks/client-performance-support';
import {
  createFullNetworkBaselineFixture,
  fullNetworkBaselineFixtureDefinitions,
} from '@/tests/fixtures/connections-full-network';
import { selectLegacyInitialConnectionsStage } from '@/tests/benchmarks/legacy-connections-staging';

const warmupIterations = 1;
const measuredIterations = 5;
const isolatedTimeoutMs = 30_000;
const branchPoint = '4a2780153bcdef82cd650d19f3c8c58b94f7944f';
const vitestEntry = fileURLToPath(
  new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
);
const isolatedTest =
  'tests/benchmarks/connections-full-network-layout-isolated.benchmark.test.ts';

type Deferred<T> = Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
}>;

function deferred<T>(): Deferred<T> {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function layoutForDiagnostic(
  graph: ConnectionsLayoutGraph,
  metrics: ConnectionsLayoutMetrics,
  offset: number,
): ConnectionsLayout {
  return {
    width: offset + metrics.nodeWidth * graph.nodes.length,
    height: metrics.nodeHeight,
    nodes: graph.nodes.map((node, index) => ({
      id: node.id,
      x: offset + index * metrics.nodeWidth,
      y: 0,
      width: metrics.nodeWidth,
      height: metrics.nodeHeight,
      ports: [],
    })),
    edges: graph.edges.map((edge, index) => ({
      ...edge,
      id: `edge-${index}`,
      sourcePortId: `port-${index}-source`,
      targetPortId: `port-${index}-target`,
      sections: [
        {
          id: `section-${index}`,
          startPoint: { x: offset, y: 0 },
          bendPoints: [],
          endPoint: { x: offset + 1, y: 0 },
        },
      ],
    })),
  };
}

async function controllerAbaDiagnostic(input: ConnectionsInputModel) {
  const metrics = defaultConnectionsPresentation.layoutMetrics;
  const alternateMetrics = { ...metrics, nodeWidth: metrics.nodeWidth + 1 };
  const requests: {
    graph: ConnectionsLayoutGraph;
    deferred: Deferred<ConnectionsLayout>;
  }[] = [];
  const runner: ConnectionsLayoutRunner = (graph) => {
    const request = { graph, deferred: deferred<ConnectionsLayout>() };
    requests.push(request);
    return request.deferred.promise;
  };
  const controller = createConnectionsController(input, metrics, runner);
  controller.update(input, metrics);
  const first = requests[0];
  invariant(first, 'A→B→A diagnostic omitted request A');
  first.deferred.resolve(layoutForDiagnostic(first.graph, metrics, 0));
  await Promise.resolve();
  await Promise.resolve();
  controller.update(input, alternateMetrics);
  const second = requests[1];
  invariant(second, 'A→B→A diagnostic omitted request B');
  controller.update(input, metrics);
  const stateAfterReturnToA = controller.getState();
  second.deferred.resolve(
    layoutForDiagnostic(second.graph, alternateMetrics, 1_000),
  );
  await Promise.resolve();
  await Promise.resolve();
  const stateAfterBSettled = controller.getState();
  const keyA = connectionsLayoutKey(input, metrics);
  const keyB = connectionsLayoutKey(input, alternateMetrics);
  const staleBWasAccepted =
    stateAfterReturnToA.layoutKey === keyA &&
    stateAfterBSettled.layoutKey === keyB &&
    stateAfterBSettled.status === 'ready';
  controller.destroy();
  return {
    staleBWasAccepted,
    requestCount: requests.length,
    returnedToAKeyBeforeBSettled: stateAfterReturnToA.layoutKey === keyA,
    changedToBKeyAfterBSettled: stateAfterBSettled.layoutKey === keyB,
  };
}

function tombstoneVisibilityDiagnostic(cards: readonly CardRecord[]) {
  const retained = cards[0];
  const remotelyDeleted = cards[1];
  invariant(retained, 'Tombstone diagnostic omitted retained card');
  invariant(remotelyDeleted, 'Tombstone diagnostic omitted deleted card');
  const currentCards = [retained, remotelyDeleted];
  const visible = reconcileVisibleCardsAfterSync({
    currentCards,
    revisionsAtRequest: new Map(
      currentCards.map((card) => [card.id, card.localRevision]),
    ),
    mergedCards: [retained],
  });
  return {
    remotelyDeletedCardRemainsVisible: visible.some(
      (card) => card.id === remotelyDeleted.id,
    ),
    currentCount: currentCards.length,
    mergedCount: 1,
    visibleCount: visible.length,
  };
}

function tail(value: string): string {
  return value.length <= 4_000 ? value : value.slice(-4_000);
}

async function runIsolatedLayout(fixture: string, mode: FullNetworkLayoutMode) {
  const directory = await mkdtemp(
    join(tmpdir(), 'fukamu-connections-baseline-'),
  );
  const resultPath = join(directory, 'result.json');
  const started = performance.now();
  let timedOut = false;
  let standardOutput = '';
  let standardError = '';
  const child = spawn(
    process.execPath,
    [
      vitestEntry,
      'run',
      isolatedTest,
      '--config',
      'vitest.benchmark.config.ts',
      '--reporter=verbose',
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        CONNECTIONS_BASELINE_FIXTURE: fixture,
        CONNECTIONS_BASELINE_MODE: mode,
        CONNECTIONS_BASELINE_RESULT_PATH: resultPath,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    standardOutput += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    standardError += chunk;
  });
  const completed = new Promise<{
    exitCode: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('exit', (exitCode, signal) => resolve({ exitCode, signal }));
  });
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGKILL');
  }, isolatedTimeoutMs);
  const exit = await completed;
  clearTimeout(timer);
  const processWallMs = performance.now() - started;
  const serialized = await readFile(resultPath, 'utf8');
  const parsed: unknown = JSON.parse(serialized);
  const result = decodeIsolatedFullNetworkLayoutResult(parsed);
  await rm(directory, { recursive: true, force: true });
  const outcome = timedOut
    ? 'timeout'
    : exit.exitCode === 0 && result.status === 'completed'
      ? 'completed'
      : 'failed';
  return {
    outcome,
    timeoutMs: isolatedTimeoutMs,
    processWallMs: Number(processWallMs.toFixed(3)),
    exitCode: exit.exitCode,
    signal: exit.signal,
    result,
    layoutDistribution:
      result.layoutSamplesMs.length === 0
        ? null
        : summarizeClientBenchmarkSamples(result.layoutSamplesMs),
    pathDistribution:
      result.pathSamplesMs.length === 0
        ? null
        : summarizeClientBenchmarkSamples(result.pathSamplesMs),
    standardOutputTail: tail(standardOutput),
    standardErrorTail: tail(standardError),
  };
}

describe('connections full-network phase 0 baseline artifact', () => {
  it('separates staged A from full-graph B and records bounded ELK feasibility', async () => {
    const fixtures = [];
    const diagnosticFixture = createFullNetworkBaselineFixture(
      'boundary-64-connected',
    );
    for (const definition of fullNetworkBaselineFixtureDefinitions) {
      const memoryBefore = process.memoryUsage();
      const generation = measureOperation(
        warmupIterations,
        measuredIterations,
        () => createFullNetworkBaselineFixture(definition.name).cards.length,
      );
      const fixture = createFullNetworkBaselineFixture(definition.name);
      let fullInput = selectConnectionsViewModel(
        fixture.cards,
        fixture.currentCardId,
      );
      const semanticInput = measureOperation(
        warmupIterations,
        measuredIterations,
        () => {
          fullInput = selectConnectionsViewModel(
            fixture.cards,
            fixture.currentCardId,
          );
          return fullInput.nodes.length + fullInput.edges.length;
        },
      );
      let staged = selectLegacyInitialConnectionsStage(fullInput);
      const staging = measureOperation(
        warmupIterations,
        measuredIterations,
        () => {
          staged = selectLegacyInitialConnectionsStage(fullInput);
          return staged.input.nodes.length + staged.input.edges.length;
        },
      );
      let stagedGraph = connectionsLayoutGraph(staged.input);
      const stagedTransform = measureOperation(
        warmupIterations,
        measuredIterations,
        () => {
          stagedGraph = connectionsLayoutGraph(staged.input);
          return stagedGraph.nodes.length + stagedGraph.edges.length;
        },
      );
      let fullGraph = connectionsLayoutGraph(fullInput);
      const fullTransform = measureOperation(
        warmupIterations,
        measuredIterations,
        () => {
          fullGraph = connectionsLayoutGraph(fullInput);
          return fullGraph.nodes.length + fullGraph.edges.length;
        },
      );
      const memoryAfter = process.memoryUsage();
      expect(fullGraph.nodes).toHaveLength(definition.nodeCount);
      expect(new Set(fullGraph.nodes.map(({ id }) => id)).size).toBe(
        definition.nodeCount,
      );
      fixtures.push({
        definition,
        actualEdges: fullGraph.edges.length,
        stagedSelection: {
          nodes: staged.input.nodes.length,
          edges: staged.input.edges.length,
          hiddenReachableNodes: staged.hiddenReachableNodeCount,
          stoppedAtMaximum: staged.stoppedAtMaximum,
        },
        shapes: {
          staged: fullNetworkGraphShape(stagedGraph),
          full: fullNetworkGraphShape(fullGraph),
        },
        timings: {
          fixtureGeneration: generation.timing,
          semanticInput: semanticInput.timing,
          staging: staging.timing,
          stagedLayoutInputTransform: stagedTransform.timing,
          fullLayoutInputTransform: fullTransform.timing,
        },
        memoryObservation: {
          heapDeltaBytes: memoryAfter.heapUsed - memoryBefore.heapUsed,
          rssDeltaBytes: memoryAfter.rss - memoryBefore.rss,
        },
      });
    }

    const isolatedLayouts = [];
    for (const definition of fullNetworkBaselineFixtureDefinitions) {
      for (const selectedMode of ['staged', 'full'] as const) {
        console.info(`full-network-layout ${definition.name} ${selectedMode}`);
        isolatedLayouts.push(
          await runIsolatedLayout(definition.name, selectedMode),
        );
      }
    }

    const aba = await controllerAbaDiagnostic(
      selectConnectionsViewModel(
        diagnosticFixture.cards,
        diagnosticFixture.currentCardId,
      ),
    );
    const tombstone = tombstoneVisibilityDiagnostic(diagnosticFixture.cards);
    const artifact = {
      schemaVersion: 1,
      issue: 305,
      parentIssue: 304,
      branchPoint,
      analysisSha: branchPoint,
      latestIntegrationSha: branchPoint,
      latestIntegrationDiff: { commits: 0, files: 0 },
      generatedAt: new Date().toISOString(),
      environment: {
        node: process.version,
        requiredCiNode: '22.13.0',
        platform: platform(),
        release: release(),
        cpu: cpus()[0]?.model ?? 'unknown',
        cpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        elkjs: '0.12.0',
        layoutConfiguration: 'production FREE + ORTHOGONAL + thoroughness 7',
        layoutMetrics: defaultConnectionsPresentation.layoutMetrics,
      },
      methodology: {
        comparison:
          'A is the current expansionPage=0 staged graph. B is the complete semantic graph before staging. Their different memberships are never treated as equivalent output.',
        timing:
          'Synchronous boundaries use one warmup and five measured samples. ELK runs in a child Vitest process with the production main-thread runner and persists partial progress before each possibly blocking layout.',
        outliers:
          'No sample is removed. Partial samples and timeout outcomes remain in the artifact.',
        isolationTimeoutMs: isolatedTimeoutMs,
        timeoutMeaning:
          'A research guard, not a user-facing SLO. A timeout is an incomplete result and never a pass.',
        nodeBrowserSeparation:
          'This artifact measures graph/staging/layout/path work. Existing Playwright connections readiness/gesture tests and the augmented 10k staged test record browser commit, long-task, frame-gap, DOM and camera evidence separately.',
        qualityWorkExcluded:
          'Pairwise edge-quality analysis and sampled curve serialization are excluded from large-case layout wall-clock timing.',
      },
      runtimeScope: {
        currentRoute: 'LegacyNotesApp',
        authorizedCollection:
          'The active provider replica for one permitted scope; accounts, Vaults and databases are never unioned.',
        onlineCompleteness:
          'Requires Sync v2 terminal-page success. initial-sync-completed alone is not proof because it also occurs after failure.',
        offlineCompleteness:
          'Only the locally retained replica is available; unseen remote records are not claimed.',
      },
      fixtures,
      isolatedLayouts,
      diagnostics: {
        controllerAba: aba,
        tombstoneVisibility: tombstone,
        syncV2Paging:
          'A focused unit contract covers 501 changes across a 500-change intermediate page and a terminal page.',
        scopeIsolation:
          'Existing vault runtime, IndexedDB and Sync v2 tests retain scope in their ports/repositories; no cross-scope product change is made in phase 0.',
      },
      provisionalBudgets: {
        cameraAndVisibilityP95Ms: 8,
        interactionLongTaskMaximumMs: 50,
        absoluteInitialLayout:
          'Set only after interpreting these results on the required Node 22.13.0 CI host and desktop/mobile Chromium.',
      },
    };

    const boundary64 = fixtures.find(
      ({ definition }) => definition.name === 'boundary-64-connected',
    );
    const boundary65 = fixtures.find(
      ({ definition }) => definition.name === 'boundary-65-connected',
    );
    const mixed257 = fixtures.find(
      ({ definition }) => definition.name === 'boundary-257-mixed',
    );
    invariant(boundary64, 'Missing boundary 64 result');
    invariant(boundary65, 'Missing boundary 65 result');
    invariant(mixed257, 'Missing mixed 257 result');
    expect(boundary64.stagedSelection.nodes).toBe(64);
    expect(boundary65.stagedSelection.nodes).toBe(64);
    expect(mixed257.shapes.full.nodes).toBe(257);
    expect(mixed257.shapes.full.weaklyConnectedComponents).toBe(35);
    expect(mixed257.shapes.full.isolatedNodes).toBe(33);
    expect(isolatedLayouts).toHaveLength(
      fullNetworkBaselineFixtureDefinitions.length * 2,
    );

    await mkdir('docs/benchmarks', { recursive: true });
    await writeFile(
      'docs/benchmarks/connections-full-network-baseline.json',
      `${JSON.stringify(artifact, null, 2)}\n`,
      'utf8',
    );
  }, 600_000);
});
