import { describe, expect, it, vi } from 'vitest';
import {
  createConnectionsLayoutWorkerManager,
  type ConnectionsLayoutWorkerManager,
} from '@/lib/client/connections-layout-worker';
import type { ConnectionsLayoutRunner } from '@/lib/graph/connections-controller';
import type {
  ConnectionsLayout,
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';
import { fixtureCardId } from '@/tests/fixtures/ids';

const nodeId = fixtureCardId('logout-worker-node');
const graph: ConnectionsLayoutGraph = {
  nodes: [{ id: nodeId }],
  edges: [],
};
const metrics: ConnectionsLayoutMetrics = {
  nodeWidth: 196,
  nodeHeight: 72,
  portSize: 2,
  componentSpacing: 96,
  nodeSpacing: 72,
  edgeNodeSpacing: 32,
  layerSpacing: 112,
  edgeLayerSpacing: 40,
  padding: { top: 24, right: 24, bottom: 24, left: 24 },
};
const layout: ConnectionsLayout = {
  width: 244,
  height: 120,
  nodes: [
    {
      id: nodeId,
      x: 24,
      y: 24,
      width: 196,
      height: 72,
      ports: [],
    },
  ],
  edges: [],
};

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

describe('connections layout worker logout reset', () => {
  it('terminates the worker, rejects in-flight work, and drops its cache', async () => {
    const firstReady = deferred<void>();
    const firstLayout = deferred<ConnectionsLayout>();
    const terminateFirst = vi.fn();
    const secondRun = vi.fn<ConnectionsLayoutRunner>(async () => layout);
    let created = 0;
    const manager: ConnectionsLayoutWorkerManager =
      createConnectionsLayoutWorkerManager(() => {
        created += 1;
        if (created === 1) {
          return {
            ready: firstReady.promise,
            run: () => firstLayout.promise,
            terminate: terminateFirst,
          };
        }
        return {
          ready: Promise.resolve(),
          run: secondRun,
          terminate: vi.fn(),
        };
      });

    const preparing = manager.prepare();
    const pendingLayout = manager.layout(graph, metrics);
    expect(manager.reset()).toEqual({
      kind: 'reset',
      rejectedOperations: 2,
    });
    expect(terminateFirst).toHaveBeenCalledOnce();
    await expect(preparing).rejects.toThrow('terminated for logout');
    await expect(pendingLayout).rejects.toThrow('terminated for logout');
    expect(manager.isReset()).toBe(true);
    expect(manager.reset()).toEqual({ kind: 'already-reset' });

    await expect(manager.layout(graph, metrics)).resolves.toEqual(layout);
    expect(created).toBe(2);
    expect(secondRun).toHaveBeenCalledOnce();
    expect(manager.isReset()).toBe(false);
  });
});
