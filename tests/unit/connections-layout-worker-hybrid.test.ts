import { describe, expect, it, vi } from 'vitest';
import {
  createConnectionsCorridorWorkerExecutor,
  createHybridConnectionsLayoutWorkerExecutor,
  type ConnectionsCorridorWorkerPort,
  type ConnectionsLayoutWorkerExecutor,
} from '@/lib/client/connections-layout-worker';
import { ConnectionsLayoutSupersededError } from '@/lib/client/connections-layout-scheduler';
import { layoutConnectionsCorridors } from '@/lib/graph/connections-corridor-layout';
import { CONNECTIONS_LAYOUT_POLICY_REVISION } from '@/lib/graph/connections-layout-policy';
import type {
  ConnectionsLayout,
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';
import { fixtureCardId } from '@/tests/fixtures/ids';

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

function graph(nodeCount: number): ConnectionsLayoutGraph {
  return {
    nodes: Array.from({ length: nodeCount }, (_, index) => ({
      id: fixtureCardId(`hybrid-worker-${nodeCount}-${index}`),
    })),
    edges: [],
  };
}

function layout(input: ConnectionsLayoutGraph, offset = 0): ConnectionsLayout {
  return {
    width: Math.max(1, offset + input.nodes.length * 2),
    height: 1,
    nodes: input.nodes.map((node, index) => ({
      id: node.id,
      x: offset + index * 2,
      y: 0,
      width: 1,
      height: 1,
      ports: [],
    })),
    edges: [],
  };
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function engine(
  run: ConnectionsLayoutWorkerExecutor['run'],
  ready: Promise<void> = Promise.resolve(),
) {
  return {
    ready,
    run,
    terminate: vi.fn(),
  } satisfies ConnectionsLayoutWorkerExecutor;
}

class FakeCorridorPort implements ConnectionsCorridorWorkerPort {
  readonly posted: unknown[] = [];
  readonly terminate = vi.fn();
  private readonly messageListeners = new Set<(message: unknown) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  onMessage(listener: (message: unknown) => void): () => void {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  emitMessage(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) listener(error);
  }
}

describe('connections corridor Worker executor', () => {
  it('waits for ready, posts the complete request, and decodes complete geometry', async () => {
    const port = new FakeCorridorPort();
    const measure = vi.fn();
    const executor = createConnectionsCorridorWorkerExecutor(
      4,
      () => port,
      measure,
    );
    const input = graph(2);
    let readySettled = false;
    void executor.ready.then(() => {
      readySettled = true;
    });
    await Promise.resolve();
    expect(readySettled).toBe(false);

    port.emitMessage({
      type: 'ready',
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
    });
    await executor.ready;
    const operation = executor.run(input, metrics);
    await vi.waitFor(() => expect(port.posted).toHaveLength(1));
    expect(port.posted[0]).toMatchObject({
      type: 'layout',
      requestId: 1,
      generation: 4,
      graph: input,
    });
    const result = layoutConnectionsCorridors(input, metrics, {
      laneSpacing: 8,
    });
    port.emitMessage({
      type: 'completed',
      requestId: 1,
      generation: 4,
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
      workerLayoutMs: 1,
      layout: result,
    });
    await expect(operation).resolves.toEqual(result);
    expect(measure).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 1,
        generation: 4,
        workerLayoutMs: 1,
      }),
    );
  });

  it('rejects invalid generations and terminates pending operations', async () => {
    const port = new FakeCorridorPort();
    const executor = createConnectionsCorridorWorkerExecutor(2, () => port);
    port.emitMessage({
      type: 'ready',
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
    });
    await executor.ready;
    const operation = executor.run(graph(1), metrics);
    await vi.waitFor(() => expect(port.posted).toHaveLength(1));
    port.emitMessage({
      type: 'failed',
      requestId: 1,
      generation: 1,
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
      failure: 'old generation',
    });
    await expect(operation).rejects.toThrow('generation changed');
    await expect(executor.run(graph(1), metrics)).rejects.toThrow(
      'generation changed',
    );
    expect(port.posted).toHaveLength(1);
    executor.terminate();
    expect(port.terminate).toHaveBeenCalledOnce();
    await expect(executor.run(graph(1), metrics)).rejects.toThrow(
      'terminated for logout',
    );
  });

  it('keeps per-request failure and measurement observers from poisoning the Worker', async () => {
    const port = new FakeCorridorPort();
    const executor = createConnectionsCorridorWorkerExecutor(
      7,
      () => port,
      () => {
        throw new Error('measurement sink failed');
      },
    );
    port.emitMessage({
      type: 'ready',
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
    });
    await executor.ready;
    const input = graph(1);
    const failed = executor.run(input, metrics);
    await vi.waitFor(() => expect(port.posted).toHaveLength(1));
    port.emitMessage({
      type: 'failed',
      requestId: 1,
      generation: 7,
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
      failure: 'temporary route failure',
    });
    await expect(failed).rejects.toThrow('temporary route failure');

    const retried = executor.run(input, metrics);
    await vi.waitFor(() => expect(port.posted).toHaveLength(2));
    const result = layoutConnectionsCorridors(input, metrics, {
      laneSpacing: 8,
    });
    port.emitMessage({
      type: 'completed',
      requestId: 2,
      generation: 7,
      policyRevision: CONNECTIONS_LAYOUT_POLICY_REVISION,
      workerLayoutMs: 1,
      layout: result,
    });
    await expect(retried).resolves.toEqual(result);
  });
});

describe('hybrid connections layout Worker executor', () => {
  it('falls back when ELK preparation does not finish before the deadline', async () => {
    vi.useFakeTimers();
    try {
      const input = graph(2);
      const elkReady = deferred<void>();
      const elkRun = vi.fn(async (value: ConnectionsLayoutGraph) =>
        layout(value),
      );
      const corridorRun = vi.fn(async (value: ConnectionsLayoutGraph) =>
        layout(value, 40),
      );
      const elk = engine(elkRun, elkReady.promise);
      const corridor = engine(corridorRun);
      const executor = createHybridConnectionsLayoutWorkerExecutor(0, {
        createElk: () => elk,
        createCorridor: () => corridor,
        deadlineMs: 2_000,
      });

      await executor.ready;
      const operation = executor.run(input, metrics);
      await vi.advanceTimersByTimeAsync(2_001);
      await expect(operation).resolves.toMatchObject({
        width: 44,
      });
      expect(elk.terminate).toHaveBeenCalledOnce();
      expect(elkRun).not.toHaveBeenCalled();
      expect(corridorRun).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('uses ELK for small geometry and shares the settled cache', async () => {
    const input = graph(2);
    const elkRun = vi.fn(async (value: ConnectionsLayoutGraph) =>
      layout(value),
    );
    const corridorRun = vi.fn(async (value: ConnectionsLayoutGraph) =>
      layout(value, 10),
    );
    const elk = engine(elkRun);
    const corridor = engine(corridorRun);
    const executor = createHybridConnectionsLayoutWorkerExecutor(0, {
      createElk: vi.fn(() => elk),
      createCorridor: vi.fn(() => corridor),
      deadlineMs: 2_000,
    });
    await executor.ready;

    const first = await executor.run(input, metrics);
    const second = await executor.run(input, metrics);
    expect(first).toBe(second);
    expect(elkRun).toHaveBeenCalledOnce();
    expect(corridorRun).not.toHaveBeenCalled();
  });

  it('uses corridor for every node above the policy boundary', async () => {
    const input = graph(257);
    const elkRun = vi.fn(async (value: ConnectionsLayoutGraph) =>
      layout(value),
    );
    const corridorRun = vi.fn(async (value: ConnectionsLayoutGraph) =>
      layout(value),
    );
    const createCorridor = vi.fn(() => engine(corridorRun));
    const createElk = vi.fn(() => engine(elkRun));
    const executor = createHybridConnectionsLayoutWorkerExecutor(5, {
      createElk,
      createCorridor,
      deadlineMs: 2_000,
    });
    await executor.ready;

    const result = await executor.run(input, metrics);
    expect(result.nodes).toHaveLength(257);
    expect(createElk).not.toHaveBeenCalled();
    expect(elkRun).not.toHaveBeenCalled();
    expect(corridorRun).toHaveBeenCalledOnce();
    expect(createCorridor).toHaveBeenCalledWith(5);
  });

  it('falls back once after ELK failure and caches the fallback result', async () => {
    const input = graph(2);
    const elkRun = vi.fn(async () => {
      throw new Error('ELK failed');
    });
    const corridorRun = vi.fn(async (value: ConnectionsLayoutGraph) =>
      layout(value, 20),
    );
    const elk = engine(elkRun);
    const corridor = engine(corridorRun);
    const executor = createHybridConnectionsLayoutWorkerExecutor(0, {
      createElk: () => elk,
      createCorridor: () => corridor,
      deadlineMs: 2_000,
    });
    await executor.ready;

    const first = await executor.run(input, metrics);
    const second = await executor.run(input, metrics);
    expect(first).toBe(second);
    expect(first.width).toBe(24);
    expect(elkRun).toHaveBeenCalledOnce();
    expect(elk.terminate).toHaveBeenCalledOnce();
    expect(corridorRun).toHaveBeenCalledOnce();
  });

  it('evicts a failed corridor result so the complete graph can retry', async () => {
    const input = graph(257);
    const corridorRun = vi
      .fn<ConnectionsLayoutWorkerExecutor['run']>()
      .mockRejectedValueOnce(new Error('corridor failed'))
      .mockImplementationOnce(async (value) => layout(value, 50));
    const corridors: ConnectionsLayoutWorkerExecutor[] = [];
    const createCorridor = vi.fn(() => {
      const created = engine(corridorRun);
      corridors.push(created);
      return created;
    });
    const executor = createHybridConnectionsLayoutWorkerExecutor(0, {
      createElk: () => engine(async (value) => layout(value)),
      createCorridor,
      deadlineMs: 2_000,
    });

    await expect(executor.run(input, metrics)).rejects.toThrow(
      'corridor failed',
    );
    await expect(executor.run(input, metrics)).resolves.toMatchObject({
      width: 564,
    });
    expect(corridorRun).toHaveBeenCalledTimes(2);
    expect(createCorridor).toHaveBeenCalledTimes(2);
    expect(corridors[0]?.terminate).toHaveBeenCalledOnce();
  });

  it('terminates timed-out ELK and uses corridor without accepting a late result', async () => {
    vi.useFakeTimers();
    try {
      const input = graph(2);
      const elkOperation = deferred<ConnectionsLayout>();
      const elkRun = vi.fn(() => elkOperation.promise);
      const corridorRun = vi.fn(async (value: ConnectionsLayoutGraph) =>
        layout(value, 30),
      );
      const elk = engine(elkRun);
      const executor = createHybridConnectionsLayoutWorkerExecutor(0, {
        createElk: () => elk,
        createCorridor: () => engine(corridorRun),
        deadlineMs: 2_000,
      });
      await executor.ready;
      const operation = executor.run(input, metrics);
      await vi.advanceTimersByTimeAsync(2_001);

      await expect(operation).resolves.toMatchObject({ width: 34 });
      expect(elk.terminate).toHaveBeenCalledOnce();
      expect(corridorRun).toHaveBeenCalledOnce();
      elkOperation.resolve(layout(input, 999));
      await Promise.resolve();
    } finally {
      vi.useRealTimers();
    }
  });

  it('cancels queued B when returning to cached active A', async () => {
    const input = graph(2);
    const first = deferred<ConnectionsLayout>();
    const elkRun = vi.fn(() => first.promise);
    const executor = createHybridConnectionsLayoutWorkerExecutor(0, {
      createElk: () => engine(elkRun),
      createCorridor: () => engine(async (value) => layout(value)),
      deadlineMs: 2_000,
    });
    await executor.ready;
    const requestA = executor.run(input, metrics);
    await vi.waitFor(() => expect(elkRun).toHaveBeenCalledOnce());
    const requestB = executor.run(input, { ...metrics, nodeWidth: 197 });
    void requestB.catch(() => undefined);
    const returnedA = executor.run(input, metrics);

    await expect(requestB).rejects.toBeInstanceOf(
      ConnectionsLayoutSupersededError,
    );
    expect(returnedA).toBe(requestA);
    first.resolve(layout(input));
    await expect(requestA).resolves.toMatchObject({ width: 4 });
    expect(elkRun).toHaveBeenCalledOnce();
  });

  it('does not start fallback after reset invalidates the active generation', async () => {
    const input = graph(2);
    const elkOperation = deferred<ConnectionsLayout>();
    const elkRun = vi.fn(() => elkOperation.promise);
    const corridorRun = vi.fn(async (value: ConnectionsLayoutGraph) =>
      layout(value),
    );
    const executor = createHybridConnectionsLayoutWorkerExecutor(0, {
      createElk: () => engine(elkRun),
      createCorridor: () => engine(corridorRun),
      deadlineMs: 2_000,
    });
    await executor.ready;
    const operation = executor.run(input, metrics);
    await vi.waitFor(() => expect(elkRun).toHaveBeenCalledOnce());
    executor.terminate();

    await expect(operation).rejects.toThrow('terminated for logout');
    elkOperation.reject(new Error('late ELK failure'));
    await Promise.resolve();
    expect(corridorRun).not.toHaveBeenCalled();
  });
});
