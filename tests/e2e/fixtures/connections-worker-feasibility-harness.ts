import { defaultConnectionsPresentation } from '@/components/connections-presentation';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import ElkConstructor from 'elkjs/lib/elk-api.js';
import elkWorkerSource from 'elkjs/lib/elk-worker.min.js?raw';
import type {
  ConnectionsLayout,
  ConnectionsLayoutGraph,
} from '@/lib/graph/elk-layout';
import { createConnectionsLayoutRunner } from '@/lib/graph/elk-layout';
import {
  connectionsLayoutGraph,
  fullNetworkGeometryShape,
  fullNetworkGraphShape,
} from '@/tests/benchmarks/connections-full-network-baseline-support';
import type { BrowserWorkerFeasibilityCaseResult } from '@/tests/benchmarks/connections-browser-worker-feasibility-support';
import { createFullNetworkBaselineFixture } from '@/tests/fixtures/connections-full-network';

type BrowserWorkerFeasibilityHarness = Readonly<{
  run: (
    fixtureName: string,
    timeoutMs: number,
  ) => Promise<BrowserWorkerFeasibilityCaseResult>;
}>;

declare global {
  interface Window {
    __fukamuConnectionsWorkerFeasibility: BrowserWorkerFeasibilityHarness;
  }
}

type LayoutAttempt =
  | { readonly kind: 'completed'; readonly layout: ConnectionsLayout }
  | { readonly kind: 'failed'; readonly failure: string }
  | {
      readonly kind: 'timeout';
      readonly phase: 'worker-preparation' | 'layout';
      readonly afterResetKind: 'already-reset' | 'reset';
      readonly rejectedOperations: number;
    };

type WorkerAttempt = Readonly<{
  attempt: LayoutAttempt;
  workerPreparation: number;
  layoutWall: number;
  afterResetKind: 'reset';
  rejectedOperations: number;
}>;

function elapsed(started: number): number {
  return Number((performance.now() - started).toFixed(3));
}

function heapUsed(): number | null {
  const memory: unknown = Reflect.get(performance, 'memory');
  if (typeof memory !== 'object' || memory === null) return null;
  const used: unknown = Reflect.get(memory, 'usedJSHeapSize');
  return typeof used === 'number' && Number.isFinite(used) && used >= 0
    ? used
    : null;
}

function failureMessage(error: unknown): string {
  const message =
    error instanceof Error
      ? `${error.name}: ${error.message}\n${error.stack ?? ''}`
      : String(error);
  return message.length <= 12_000 ? message : message.slice(0, 12_000);
}

function nodeIdsMatch(
  graph: ConnectionsLayoutGraph,
  layout: ConnectionsLayout,
): boolean {
  return (
    graph.nodes.length === layout.nodes.length &&
    graph.nodes.every((node, index) => node.id === layout.nodes[index]?.id)
  );
}

function directedEdgesMatch(
  graph: ConnectionsLayoutGraph,
  layout: ConnectionsLayout,
): boolean {
  return (
    graph.edges.length === layout.edges.length &&
    graph.edges.every((edge, index) => {
      const laidOut = layout.edges[index];
      return (
        laidOut?.sourceCardId === edge.sourceCardId &&
        laidOut.targetCardId === edge.targetCardId
      );
    })
  );
}

async function attemptWorker(
  graph: ConnectionsLayoutGraph,
  timeoutMs: number,
): Promise<WorkerAttempt> {
  const workerUrl = URL.createObjectURL(
    new Blob([elkWorkerSource], { type: 'text/javascript' }),
  );
  const elk = new ElkConstructor({
    algorithms: ['layered'],
    workerFactory: () => new Worker(workerUrl),
  });
  const run = createConnectionsLayoutRunner(elk);
  let terminated = false;
  const terminate = () => {
    if (terminated) return;
    terminated = true;
    elk.terminateWorker();
    URL.revokeObjectURL(workerUrl);
  };
  let phase: 'worker-preparation' | 'layout' = 'worker-preparation';
  let workerPreparation = 0;
  let layoutStarted: number | undefined;
  const guarded: Promise<LayoutAttempt> = (async () => {
    const preparationStarted = performance.now();
    await elk.knownLayoutAlgorithms();
    workerPreparation = elapsed(preparationStarted);
    phase = 'layout';
    layoutStarted = performance.now();
    try {
      const layout = await run(
        graph,
        defaultConnectionsPresentation.layoutMetrics,
      );
      return { kind: 'completed', layout };
    } catch (error: unknown) {
      return { kind: 'failed', failure: failureMessage(error) };
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<LayoutAttempt>((resolve) => {
    timer = setTimeout(() => {
      terminate();
      resolve({
        kind: 'timeout',
        phase,
        afterResetKind: 'reset',
        rejectedOperations: 1,
      });
    }, timeoutMs);
  });
  const result = await Promise.race([guarded, timeout]);
  if (timer !== undefined) clearTimeout(timer);
  terminate();
  return {
    attempt: result,
    workerPreparation,
    layoutWall:
      layoutStarted === undefined
        ? 0
        : Number((performance.now() - layoutStarted).toFixed(3)),
    afterResetKind: 'reset',
    rejectedOperations:
      result.kind === 'timeout' ? result.rejectedOperations : 0,
  };
}

window.__fukamuConnectionsWorkerFeasibility = {
  async run(fixtureName, timeoutMs) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError('timeoutMs must be a positive finite number');
    }
    const generationStarted = performance.now();
    const fixture = createFullNetworkBaselineFixture(fixtureName);
    const fixtureGeneration = elapsed(generationStarted);
    const semanticStarted = performance.now();
    const input = selectConnectionsViewModel(
      fixture.cards,
      fixture.currentCardId,
    );
    const graph = connectionsLayoutGraph(input);
    const semanticInput = elapsed(semanticStarted);
    const beforeLayoutBytes = heapUsed();
    const workerAttempt = await attemptWorker(graph, timeoutMs);
    const { attempt, workerPreparation, layoutWall } = workerAttempt;
    const afterLayoutBytes = heapUsed();
    let geometry = null;
    let nodeIdsMatched = false;
    let directedEdgesMatched = false;
    let validation = 0;
    if (attempt.kind === 'completed') {
      const validationStarted = performance.now();
      nodeIdsMatched = nodeIdsMatch(graph, attempt.layout);
      directedEdgesMatched = directedEdgesMatch(graph, attempt.layout);
      geometry = fullNetworkGeometryShape(
        attempt.layout,
        defaultConnectionsPresentation.layoutMetrics,
      );
      validation = elapsed(validationStarted);
    }
    await Promise.resolve();
    return {
      schemaVersion: 1,
      fixture: fixtureName,
      outcome: attempt.kind,
      timeoutMs,
      failure:
        attempt.kind === 'failed'
          ? attempt.failure
          : attempt.kind === 'timeout'
            ? `Timed out during ${attempt.phase}`
            : null,
      phasesMs: {
        fixtureGeneration,
        semanticInput,
        workerPreparation,
        layoutWall,
        validation,
      },
      input: fullNetworkGraphShape(graph),
      geometry,
      identity: { nodeIdsMatched, directedEdgesMatched },
      memory: {
        beforeLayoutBytes,
        afterLayoutBytes,
        afterResetBytes: heapUsed(),
      },
      worker: {
        beforeResetKind: 'already-reset',
        afterResetKind: workerAttempt.afterResetKind,
        afterResetRejectedOperations: workerAttempt.rejectedOperations,
        isResetAfter: true,
      },
    };
  },
};
