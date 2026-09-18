'use client';

import ElkConstructor from 'elkjs/lib/elk-api.js';
import { createBoundedConnectionsLayoutRunner } from '@/lib/application/connections-layout-cache';
import { connectionsCorridorWorkerUrl } from '@/lib/client/connections-corridor-worker-url';
import {
  decodeConnectionsCorridorLayout,
  decodeConnectionsCorridorWorkerResponse,
  type ConnectionsCorridorWorkerRequest,
} from '@/lib/client/connections-corridor-worker-protocol';
import {
  ConnectionsLayoutSupersededError,
  createConnectionsLayoutScheduler,
} from '@/lib/client/connections-layout-scheduler';
import { connectionsLayoutWorkerUrl } from '@/lib/client/connections-layout-worker-url';
import type { ConnectionsLayoutRunner } from '@/lib/graph/connections-controller';
import { connectionsLayoutGraphKey } from '@/lib/graph/connections-layout-key';
import {
  CONNECTIONS_ELK_INITIAL_DEADLINE_MS,
  CONNECTIONS_LAYOUT_POLICY_REVISION,
  DEFAULT_CONNECTIONS_CORRIDOR_OPTIONS,
  chooseConnectionsLayoutEngine,
} from '@/lib/graph/connections-layout-policy';
import {
  createConnectionsLayoutRunner,
  type ConnectionsLayout,
  type ConnectionsLayoutGraph,
  type ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';

const maximumCachedLayouts = 4;
const terminatedMessage = 'Connections layout worker was terminated for logout';
const corridorFailedMessage = 'Connections corridor worker failed';

export type ConnectionsLayoutWorkerExecutor = {
  readonly ready: Promise<void>;
  readonly run: ConnectionsLayoutRunner;
  terminate: () => void;
};

type LayoutEngineExecutor = ConnectionsLayoutWorkerExecutor;

export type ConnectionsCorridorWorkerPort = Readonly<{
  postMessage: (message: ConnectionsCorridorWorkerRequest) => void;
  onMessage: (listener: (message: unknown) => void) => () => void;
  onError: (listener: (error: Error) => void) => () => void;
  terminate: () => void;
}>;

type PendingCorridorRequest = Readonly<{
  graph: ConnectionsLayoutGraph;
  metrics: ConnectionsLayoutMetrics;
  startedAt: number;
  resolve: (layout: ConnectionsLayout) => void;
  reject: (error: unknown) => void;
}>;

export type ConnectionsCorridorWorkerMeasurement = Readonly<{
  requestId: number;
  generation: number;
  roundTripMs: number;
  workerLayoutMs: number;
  responseDecodeMs: number;
  transferAndSchedulingMs: number;
}>;

type HybridExecutorDependencies = Readonly<{
  createElk: () => LayoutEngineExecutor;
  createCorridor: (generation: number) => LayoutEngineExecutor;
  deadlineMs: number;
}>;

export type ConnectionsLayoutWorkerResetResult =
  | { readonly kind: 'already-reset' }
  | { readonly kind: 'reset'; readonly rejectedOperations: number };

export type ConnectionsLayoutWorkerManager = {
  prepare: () => Promise<void>;
  layout: ConnectionsLayoutRunner;
  reset: () => ConnectionsLayoutWorkerResetResult;
  isReset: () => boolean;
};

function deferred<T>(): Readonly<{
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
}> {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

export function createConnectionsLayoutWorkerManager(
  createExecutor: (generation: number) => ConnectionsLayoutWorkerExecutor,
): ConnectionsLayoutWorkerManager {
  let current: ConnectionsLayoutWorkerExecutor | undefined;
  let generation = 0;
  const pending = new Set<(reason: Error) => void>();

  const executor = (): ConnectionsLayoutWorkerExecutor => {
    current ??= createExecutor(generation);
    return current;
  };

  const track = <T>(operation: Promise<T>): Promise<T> =>
    new Promise((resolve, reject) => {
      let settled = false;
      const finish = (complete: () => void) => {
        if (settled) return;
        settled = true;
        pending.delete(cancel);
        complete();
      };
      const cancel = (reason: Error) => finish(() => reject(reason));
      pending.add(cancel);
      void operation.then(
        (value) => finish(() => resolve(value)),
        (error: unknown) => finish(() => reject(error)),
      );
    });

  return {
    prepare: () => track(executor().ready),
    layout: (graph, metrics) => track(executor().run(graph, metrics)),
    reset: () => {
      const active = current;
      if (!active) return { kind: 'already-reset' };
      current = undefined;
      generation += 1;
      active.terminate();
      const cancellations = [...pending];
      const error = new Error(terminatedMessage);
      for (const cancel of cancellations) cancel(error);
      return { kind: 'reset', rejectedOperations: cancellations.length };
    },
    isReset: () => current === undefined && pending.size === 0,
  };
}

export function createConnectionsCorridorWorkerPort(
  worker: Worker,
): ConnectionsCorridorWorkerPort {
  return {
    postMessage: (message) => worker.postMessage(message),
    onMessage: (listener) => {
      const handle = (event: MessageEvent<unknown>) => listener(event.data);
      worker.addEventListener('message', handle);
      return () => worker.removeEventListener('message', handle);
    },
    onError: (listener) => {
      const handleError = () => listener(new Error(corridorFailedMessage));
      const handleMessageError = () =>
        listener(new Error('Connections corridor worker message failed'));
      worker.addEventListener('error', handleError);
      worker.addEventListener('messageerror', handleMessageError);
      return () => {
        worker.removeEventListener('error', handleError);
        worker.removeEventListener('messageerror', handleMessageError);
      };
    },
    terminate: () => worker.terminate(),
  };
}

function createBrowserCorridorWorkerPort(): ConnectionsCorridorWorkerPort {
  return createConnectionsCorridorWorkerPort(
    new Worker(connectionsCorridorWorkerUrl, { type: 'module' }),
  );
}

export function createConnectionsCorridorWorkerExecutor(
  generation: number,
  createPort: () => ConnectionsCorridorWorkerPort = createBrowserCorridorWorkerPort,
  onMeasurement: (
    measurement: ConnectionsCorridorWorkerMeasurement,
  ) => void = () => undefined,
): LayoutEngineExecutor {
  const port = createPort();
  const ready = deferred<void>();
  const pending = new Map<number, PendingCorridorRequest>();
  let nextRequestId = 1;
  let terminated = false;
  let readySettled = false;
  let fatalFailure: Readonly<{ error: unknown }> | null = null;

  const settleReady = (
    result:
      | Readonly<{ kind: 'resolved' }>
      | Readonly<{ kind: 'rejected'; error: unknown }>,
  ) => {
    if (readySettled) return;
    readySettled = true;
    if (result.kind === 'resolved') ready.resolve(undefined);
    else ready.reject(result.error);
  };
  const rejectAll = (error: unknown) => {
    fatalFailure ??= { error };
    settleReady({ kind: 'rejected', error });
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const removeMessage = port.onMessage((value) => {
    if (terminated) return;
    try {
      const response = decodeConnectionsCorridorWorkerResponse(value);
      if (response.policyRevision !== CONNECTIONS_LAYOUT_POLICY_REVISION) {
        throw new Error('Connections corridor worker policy is incompatible');
      }
      if (response.type === 'ready') {
        settleReady({ kind: 'resolved' });
        return;
      }
      if (response.generation !== generation) {
        throw new Error('Connections corridor worker generation changed');
      }
      const request = pending.get(response.requestId);
      if (!request) {
        throw new Error(
          'Connections corridor worker returned an unknown request',
        );
      }
      pending.delete(response.requestId);
      if (response.type === 'failed') {
        request.reject(new Error(response.failure));
        return;
      }
      const decodeStarted = performance.now();
      const layout = decodeConnectionsCorridorLayout(
        response.layout,
        request.graph,
        request.metrics,
      );
      const completedAt = performance.now();
      const roundTripMs = completedAt - request.startedAt;
      const responseDecodeMs = completedAt - decodeStarted;
      try {
        onMeasurement({
          requestId: response.requestId,
          generation,
          roundTripMs,
          workerLayoutMs: response.workerLayoutMs,
          responseDecodeMs,
          transferAndSchedulingMs: Math.max(
            0,
            roundTripMs - response.workerLayoutMs - responseDecodeMs,
          ),
        });
      } catch {
        // Observational measurement cannot alter layout completion or lifetime.
      }
      request.resolve(layout);
    } catch (error: unknown) {
      rejectAll(error);
    }
  });
  const removeError = port.onError((error) => {
    if (!terminated) rejectAll(error);
  });

  return {
    ready: ready.promise,
    run: async (graph, metrics) => {
      await ready.promise;
      if (terminated) throw new Error(terminatedMessage);
      if (fatalFailure) throw fatalFailure.error;
      const requestId = nextRequestId;
      nextRequestId += 1;
      const operation = deferred<ConnectionsLayout>();
      pending.set(requestId, {
        graph,
        metrics,
        startedAt: performance.now(),
        resolve: operation.resolve,
        reject: operation.reject,
      });
      try {
        port.postMessage({
          type: 'layout',
          requestId,
          generation,
          policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
          graph,
          metrics,
          options: DEFAULT_CONNECTIONS_CORRIDOR_OPTIONS,
        });
      } catch (error: unknown) {
        pending.delete(requestId);
        operation.reject(error);
      }
      return operation.promise;
    },
    terminate: () => {
      if (terminated) return;
      terminated = true;
      removeMessage();
      removeError();
      port.terminate();
      rejectAll(new Error(terminatedMessage));
    },
  };
}

function createElkWorkerExecutor(): LayoutEngineExecutor {
  const elk = new ElkConstructor({
    algorithms: ['layered'],
    workerFactory: () => new Worker(connectionsLayoutWorkerUrl),
  });
  return {
    ready: elk.knownLayoutAlgorithms().then(() => undefined),
    run: createConnectionsLayoutRunner(elk),
    terminate: () => elk.terminateWorker(),
  };
}

function deadline<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error('Connections ELK worker exceeded its deadline')),
      milliseconds,
    );
  });
  return Promise.race([operation, expired]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function createHybridConnectionsLayoutWorkerExecutor(
  generation: number,
  dependencies: HybridExecutorDependencies,
): ConnectionsLayoutWorkerExecutor {
  if (
    !Number.isFinite(dependencies.deadlineMs) ||
    dependencies.deadlineMs <= 0
  ) {
    throw new RangeError('Connections ELK deadline must be positive');
  }
  let elk: LayoutEngineExecutor | null = null;
  let corridor: LayoutEngineExecutor | null = null;
  let terminated = false;
  const scheduler = createConnectionsLayoutScheduler();

  const elkExecutor = () => {
    if (terminated) throw new Error(terminatedMessage);
    elk ??= dependencies.createElk();
    return elk;
  };
  const corridorExecutor = () => {
    if (terminated) throw new Error(terminatedMessage);
    corridor ??= dependencies.createCorridor(generation);
    return corridor;
  };
  const terminateElk = () => {
    elk?.terminate();
    elk = null;
  };
  const runCorridor: ConnectionsLayoutRunner = async (graph, metrics) => {
    const selected = corridorExecutor();
    try {
      await selected.ready;
      return await selected.run(graph, metrics);
    } catch (error: unknown) {
      if (corridor === selected) {
        selected.terminate();
        corridor = null;
      }
      throw error;
    }
  };

  const hybrid: ConnectionsLayoutRunner = async (graph, metrics) => {
    const key = connectionsLayoutGraphKey(graph, metrics);
    if (
      chooseConnectionsLayoutEngine(graph.nodes.length, graph.edges.length) ===
      'corridor'
    ) {
      return runCorridor(graph, metrics);
    }
    const selected = elkExecutor();
    try {
      return await deadline(
        selected.ready.then(() => selected.run(graph, metrics)),
        dependencies.deadlineMs,
      );
    } catch {
      terminateElk();
      if (terminated) throw new Error(terminatedMessage);
      if (!scheduler.isDesired(key)) {
        throw new ConnectionsLayoutSupersededError();
      }
      return runCorridor(graph, metrics);
    }
  };

  const scheduled: ConnectionsLayoutRunner = (graph, metrics) => {
    const key = connectionsLayoutGraphKey(graph, metrics);
    return scheduler.schedule(key, () => hybrid(graph, metrics));
  };
  const cached = createBoundedConnectionsLayoutRunner(
    scheduled,
    maximumCachedLayouts,
  );

  return {
    ready: Promise.resolve(),
    run: (graph, metrics) => {
      const key = connectionsLayoutGraphKey(graph, metrics);
      scheduler.desire(key);
      return cached(graph, metrics);
    },
    terminate: () => {
      if (terminated) return;
      terminated = true;
      const error = new Error(terminatedMessage);
      scheduler.reset(error);
      terminateElk();
      corridor?.terminate();
      corridor = null;
    },
  };
}

export function createBrowserConnectionsLayoutWorkerExecutor(
  generation: number,
  onCorridorMeasurement?: (
    measurement: ConnectionsCorridorWorkerMeasurement,
  ) => void,
  createCorridorPort: () => ConnectionsCorridorWorkerPort = createBrowserCorridorWorkerPort,
): ConnectionsLayoutWorkerExecutor {
  return createHybridConnectionsLayoutWorkerExecutor(generation, {
    createElk: createElkWorkerExecutor,
    createCorridor: (executorGeneration) =>
      createConnectionsCorridorWorkerExecutor(
        executorGeneration,
        createCorridorPort,
        onCorridorMeasurement,
      ),
    deadlineMs: CONNECTIONS_ELK_INITIAL_DEADLINE_MS,
  });
}

const browserWorkerManager = createConnectionsLayoutWorkerManager(
  createBrowserConnectionsLayoutWorkerExecutor,
);

export function prepareConnectionsLayoutWorker(): Promise<void> {
  return browserWorkerManager.prepare();
}

export const layoutConnectionsGraphInWorker: ConnectionsLayoutRunner = (
  graph,
  metrics,
) => browserWorkerManager.layout(graph, metrics);

export function resetConnectionsLayoutWorker(): ConnectionsLayoutWorkerResetResult {
  return browserWorkerManager.reset();
}

export function connectionsLayoutWorkerIsReset(): boolean {
  return browserWorkerManager.isReset();
}
