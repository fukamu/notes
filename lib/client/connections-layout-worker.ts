'use client';

import ElkConstructor from 'elkjs/lib/elk-api.js';
import { createBoundedConnectionsLayoutRunner } from '@/lib/application/connections-layout-cache';
import { connectionsLayoutWorkerUrl } from '@/lib/client/connections-layout-worker-url';
import type { ConnectionsLayoutRunner } from '@/lib/graph/connections-controller';
import { createConnectionsLayoutRunner } from '@/lib/graph/elk-layout';

const maximumCachedLayouts = 4;
const terminatedMessage = 'Connections layout worker was terminated for logout';

type ConnectionsLayoutWorkerExecutor = {
  readonly ready: Promise<void>;
  readonly run: ConnectionsLayoutRunner;
  terminate: () => void;
};

export type ConnectionsLayoutWorkerResetResult =
  | { readonly kind: 'already-reset' }
  | { readonly kind: 'reset'; readonly rejectedOperations: number };

export type ConnectionsLayoutWorkerManager = {
  prepare: () => Promise<void>;
  layout: ConnectionsLayoutRunner;
  reset: () => ConnectionsLayoutWorkerResetResult;
  isReset: () => boolean;
};

export function createConnectionsLayoutWorkerManager(
  createExecutor: () => ConnectionsLayoutWorkerExecutor,
): ConnectionsLayoutWorkerManager {
  let current: ConnectionsLayoutWorkerExecutor | undefined;
  const pending = new Set<(reason: Error) => void>();

  const executor = (): ConnectionsLayoutWorkerExecutor => {
    current ??= createExecutor();
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
      active.terminate();
      const cancellations = [...pending];
      const error = new Error(terminatedMessage);
      for (const cancel of cancellations) cancel(error);
      return { kind: 'reset', rejectedOperations: cancellations.length };
    },
    isReset: () => current === undefined && pending.size === 0,
  };
}

function createBrowserWorkerExecutor(): ConnectionsLayoutWorkerExecutor {
  const elk = new ElkConstructor({
    algorithms: ['layered'],
    workerFactory: () => new Worker(connectionsLayoutWorkerUrl),
  });
  return {
    ready: elk.knownLayoutAlgorithms().then(() => undefined),
    run: createBoundedConnectionsLayoutRunner(
      createConnectionsLayoutRunner(elk),
      maximumCachedLayouts,
    ),
    terminate: () => elk.terminateWorker(),
  };
}

const browserWorkerManager = createConnectionsLayoutWorkerManager(
  createBrowserWorkerExecutor,
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
