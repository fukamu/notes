'use client';

import ElkConstructor from 'elkjs/lib/elk-api.js';
import { createBoundedConnectionsLayoutRunner } from '@/lib/application/connections-layout-cache';
import { connectionsLayoutWorkerUrl } from '@/lib/client/connections-layout-worker-url';
import type { ConnectionsLayoutRunner } from '@/lib/graph/connections-controller';
import { createConnectionsLayoutRunner } from '@/lib/graph/elk-layout';

const maximumCachedLayouts = 4;
let runner: ConnectionsLayoutRunner | undefined;
let workerReady: Promise<void> | undefined;

function connectionsWorkerRunner(): ConnectionsLayoutRunner {
  if (runner) return runner;
  const elk = new ElkConstructor({
    algorithms: ['layered'],
    workerFactory: () => new Worker(connectionsLayoutWorkerUrl),
  });
  workerReady = elk.knownLayoutAlgorithms().then(() => undefined);
  runner = createBoundedConnectionsLayoutRunner(
    createConnectionsLayoutRunner(elk),
    maximumCachedLayouts,
  );
  return runner;
}

export function prepareConnectionsLayoutWorker(): Promise<void> {
  connectionsWorkerRunner();
  return workerReady ?? Promise.resolve();
}

export const layoutConnectionsGraphInWorker: ConnectionsLayoutRunner = (
  graph,
  metrics,
) => connectionsWorkerRunner()(graph, metrics);
