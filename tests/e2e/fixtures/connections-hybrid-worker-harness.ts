import { defaultConnectionsPresentation } from '@/components/connections-presentation';
import { selectConnectionsViewModel } from '@/lib/application/view-models';
import {
  createBrowserConnectionsLayoutWorkerExecutor,
  createConnectionsCorridorWorkerPort,
  createConnectionsLayoutWorkerManager,
  type ConnectionsCorridorWorkerMeasurement,
} from '@/lib/client/connections-layout-worker';
import { default as InlineCorridorWorker } from '@/lib/client/connections-corridor-worker-entry.ts?worker&inline';
import type {
  ConnectionsLayout,
  ConnectionsLayoutGraph,
} from '@/lib/graph/elk-layout';
import {
  connectionsLayoutGraph,
  fullNetworkGeometryShape,
  fullNetworkGraphShape,
} from '@/tests/benchmarks/connections-full-network-baseline-support';
import type { BrowserWorkerFeasibilityCaseResult } from '@/tests/benchmarks/connections-browser-worker-feasibility-support';
import { createFullNetworkBaselineFixture } from '@/tests/fixtures/connections-full-network';

type HybridWorkerCaseResult = BrowserWorkerFeasibilityCaseResult &
  Readonly<{
    corridorTiming: ConnectionsCorridorWorkerMeasurement | null;
    curvePreparationMs: number;
  }>;

type HybridWorkerHarness = Readonly<{
  run: (
    fixtureName: string,
    timeoutMs: number,
  ) => Promise<HybridWorkerCaseResult>;
}>;

declare global {
  interface Window {
    __fukamuConnectionsHybridWorker: HybridWorkerHarness;
  }
}

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

window.__fukamuConnectionsHybridWorker = {
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
    const measurements: ConnectionsCorridorWorkerMeasurement[] = [];
    const manager = createConnectionsLayoutWorkerManager((generation) =>
      createBrowserConnectionsLayoutWorkerExecutor(
        generation,
        (measurement) => measurements.push(measurement),
        () => createConnectionsCorridorWorkerPort(new InlineCorridorWorker()),
      ),
    );
    const beforeLayoutBytes = heapUsed();
    const preparationStarted = performance.now();
    await manager.prepare();
    const workerPreparation = elapsed(preparationStarted);
    const layoutStarted = performance.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const layoutAttempt = manager
      .layout(graph, defaultConnectionsPresentation.layoutMetrics)
      .then(
        (layout) => ({ kind: 'completed' as const, layout }),
        (error: unknown) => ({
          kind: 'failed' as const,
          failure: failureMessage(error),
        }),
      );
    const timeout = new Promise<Readonly<{ kind: 'timeout' }>>((resolve) => {
      timer = setTimeout(() => {
        manager.reset();
        resolve({ kind: 'timeout' });
      }, timeoutMs);
    });
    const attempt = await Promise.race([layoutAttempt, timeout]);
    if (timer !== undefined) clearTimeout(timer);
    const layoutWall = elapsed(layoutStarted);
    const afterLayoutBytes = heapUsed();
    let geometry = null;
    let nodeIdsMatched = false;
    let directedEdgesMatched = false;
    let validation = 0;
    let curvePreparationMs = 0;
    if (attempt.kind === 'completed') {
      nodeIdsMatched = nodeIdsMatch(graph, attempt.layout);
      directedEdgesMatched = directedEdgesMatch(graph, attempt.layout);
      const curveStarted = performance.now();
      geometry = fullNetworkGeometryShape(
        attempt.layout,
        defaultConnectionsPresentation.layoutMetrics,
      );
      curvePreparationMs = elapsed(curveStarted);
      validation = curvePreparationMs;
    }
    const reset = manager.reset();
    const afterResetBytes = heapUsed();
    return {
      schemaVersion: 1,
      fixture: fixtureName,
      outcome: attempt.kind,
      timeoutMs,
      failure:
        attempt.kind === 'failed'
          ? attempt.failure
          : attempt.kind === 'timeout'
            ? 'Timed out during hybrid layout'
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
      memory: { beforeLayoutBytes, afterLayoutBytes, afterResetBytes },
      worker: {
        beforeResetKind: 'already-reset',
        afterResetKind: reset.kind,
        afterResetRejectedOperations:
          reset.kind === 'reset' ? reset.rejectedOperations : 0,
        isResetAfter: manager.isReset(),
      },
      corridorTiming: measurements.at(-1) ?? null,
      curvePreparationMs,
    };
  },
};
