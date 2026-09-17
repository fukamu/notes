import { describe, expect, it, vi } from 'vitest';
import { createBoundedConnectionsLayoutRunner } from '@/lib/application/connections-layout-cache';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import {
  createConnectionsController,
  type ConnectionsLayoutRunner,
} from '@/lib/graph/connections-controller';
import type {
  ConnectionsLayout,
  ConnectionsLayoutGraph,
  ConnectionsLayoutMetrics,
} from '@/lib/graph/elk-layout';
import { fixtureCardId } from '@/tests/fixtures/ids';

const firstId = fixtureCardId('connections-first');
const secondId = fixtureCardId('connections-second');

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

function input(currentCardId = firstId): ConnectionsInputModel {
  return {
    currentCardId,
    nodes: [
      {
        cardId: firstId,
        displayLabel: '#1',
        title: 'First',
        accessibleName:
          currentCardId === firstId ? '#1 First、現在のカード' : '#1 First',
        current: currentCardId === firstId,
      },
      {
        cardId: secondId,
        displayLabel: '#2',
        title: 'Second',
        accessibleName:
          currentCardId === secondId ? '#2 Second、現在のカード' : '#2 Second',
        current: currentCardId === secondId,
      },
    ],
    edges: [
      {
        sourceCardId: firstId,
        targetCardId: secondId,
        accessibleName: 'First から Second へのリンク',
      },
    ],
  };
}

function layout(graph: ConnectionsLayoutGraph, offset = 0): ConnectionsLayout {
  return {
    width: 480 + offset,
    height: 160,
    nodes: graph.nodes.map((node, index) => ({
      id: node.id,
      x: offset + 24 + index * 240,
      y: 24,
      width: metrics.nodeWidth,
      height: metrics.nodeHeight,
      ports: [],
    })),
    edges: graph.edges.map((edge, index) => ({
      ...edge,
      id: `edge-${index}`,
      sourcePortId: `source-${index}`,
      targetPortId: `target-${index}`,
      sections: [
        {
          id: `section-${index}`,
          startPoint: { x: 220 + offset, y: 60 },
          bendPoints: [{ x: 240 + offset, y: 60 }],
          endPoint: { x: 264 + offset, y: 60 },
          incomingShape: `source-${index}`,
          outgoingShape: `target-${index}`,
        },
      ],
    })),
  };
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe('connections controller', () => {
  it('moves from loading to a complete semantic ready model', async () => {
    const runner: ConnectionsLayoutRunner = async (graph) => layout(graph);
    const controller = createConnectionsController(input(), metrics, runner);
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.update(input(), metrics);
    expect(controller.getState()).toMatchObject({
      status: 'loading',
      currentCardId: firstId,
    });
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));

    const state = controller.getState();
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.currentNode?.cardId).toBe(firstId);
    expect(state.nodes[0]).toMatchObject({
      cardId: firstId,
      displayLabel: '#1',
      x: 24,
      width: 196,
    });
    expect(state.edges[0]).toMatchObject({
      sourceCardId: firstId,
      targetCardId: secondId,
      accessibleName: 'First から Second へのリンク',
      sourcePortId: 'source-0',
    });
    expect(state.edges[0]?.sections[0]?.bendPoints).toEqual([
      { x: 240, y: 60 },
    ]);
    expect(listener).toHaveBeenCalled();
  });

  it('remaps current semantics without rerunning an unchanged layout', async () => {
    const runner = vi.fn<ConnectionsLayoutRunner>(async (graph) =>
      layout(graph),
    );
    const controller = createConnectionsController(input(), metrics, runner);
    controller.update(input(), metrics);
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));

    controller.update(input(secondId), metrics);
    const state = controller.getState();
    expect(state.status).toBe('ready');
    if (state.status !== 'ready') return;
    expect(state.currentNode?.cardId).toBe(secondId);
    expect(state.nodes.find((node) => node.cardId === secondId)?.current).toBe(
      true,
    );
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('shares a bounded settled layout across controller re-entry', async () => {
    const source = vi.fn<ConnectionsLayoutRunner>(async (graph) =>
      layout(graph),
    );
    const runner = createBoundedConnectionsLayoutRunner(source, 2);
    const first = createConnectionsController(input(), metrics, runner);
    first.update(input(), metrics);
    await vi.waitFor(() => expect(first.getState().status).toBe('ready'));
    first.destroy();

    const second = createConnectionsController(
      input(secondId),
      metrics,
      runner,
    );
    second.update(input(secondId), metrics);
    await vi.waitFor(() => expect(second.getState().status).toBe('ready'));

    expect(second.getState()).toMatchObject({
      status: 'ready',
      currentCardId: secondId,
    });
    expect(source).toHaveBeenCalledTimes(1);
  });

  it('evicts rejected work so a later controller can retry', async () => {
    const source = vi
      .fn<ConnectionsLayoutRunner>()
      .mockRejectedValueOnce(new Error('temporary worker failure'))
      .mockImplementation(async (graph) => layout(graph));
    const runner = createBoundedConnectionsLayoutRunner(source, 2);
    const failed = createConnectionsController(input(), metrics, runner);
    failed.update(input(), metrics);
    await vi.waitFor(() => expect(failed.getState().status).toBe('error'));

    const retried = createConnectionsController(input(), metrics, runner);
    retried.update(input(), metrics);
    await vi.waitFor(() => expect(retried.getState().status).toBe('ready'));

    expect(source).toHaveBeenCalledTimes(2);
  });

  it('evicts least-recently-used layouts at the configured bound', async () => {
    const source = vi.fn<ConnectionsLayoutRunner>(async (graph) =>
      layout(graph),
    );
    const runner = createBoundedConnectionsLayoutRunner(source, 1);
    const graph: ConnectionsLayoutGraph = {
      nodes: input().nodes.map(({ cardId: id }) => ({ id })),
      edges: input().edges.map(({ sourceCardId, targetCardId }) => ({
        sourceCardId,
        targetCardId,
      })),
    };
    const widerMetrics = { ...metrics, nodeWidth: metrics.nodeWidth + 1 };

    await runner(graph, metrics);
    await runner(graph, metrics);
    await runner(graph, widerMetrics);
    await runner(graph, metrics);

    expect(source).toHaveBeenCalledTimes(3);
  });

  it('rejects an invalid layout-cache capacity', () => {
    const source: ConnectionsLayoutRunner = async (graph) => layout(graph);

    expect(() => createBoundedConnectionsLayoutRunner(source, 0)).toThrow(
      'capacity must be positive',
    );
  });

  it('starts a new loading cycle when the semantic graph changes', async () => {
    const runner = vi.fn<ConnectionsLayoutRunner>(async (graph) =>
      layout(graph),
    );
    const controller = createConnectionsController(input(), metrics, runner);
    controller.update(input(), metrics);
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));

    const withoutEdges = { ...input(), edges: [] };
    controller.update(withoutEdges, metrics);
    expect(controller.getState().status).toBe('loading');
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    const state = controller.getState();
    expect(state.status === 'ready' && state.edges).toEqual([]);
    expect(runner).toHaveBeenCalledTimes(2);
  });

  it('discards stale graph and metrics promises', async () => {
    const first = deferred<ConnectionsLayout>();
    const second = deferred<ConnectionsLayout>();
    const graphs: ConnectionsLayoutGraph[] = [];
    const runner: ConnectionsLayoutRunner = (graph) => {
      graphs.push(graph);
      return graphs.length === 1 ? first.promise : second.promise;
    };
    const controller = createConnectionsController(input(), metrics, runner);
    controller.update(input(), metrics);
    const spacious = { ...metrics, nodeWidth: 232, layerSpacing: 148 };
    controller.update(input(secondId), spacious);

    second.resolve(
      layout(graphs[1] ?? graphs[0] ?? { nodes: [], edges: [] }, 50),
    );
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    const accepted = controller.getState();
    expect(accepted.status === 'ready' && accepted.width).toBe(530);
    expect(accepted.currentCardId).toBe(secondId);

    first.resolve(layout(graphs[0] ?? { nodes: [], edges: [] }, 500));
    await Promise.resolve();
    expect(controller.getState()).toBe(accepted);
  });

  it('keeps settled A when active B resolves after returning to A', async () => {
    const first = deferred<ConnectionsLayout>();
    const second = deferred<ConnectionsLayout>();
    const graphs: ConnectionsLayoutGraph[] = [];
    const runner: ConnectionsLayoutRunner = (graph) => {
      graphs.push(graph);
      return graphs.length === 1 ? first.promise : second.promise;
    };
    const controller = createConnectionsController(input(), metrics, runner);

    controller.update(input(), metrics);
    first.resolve(layout(graphs[0] ?? { nodes: [], edges: [] }));
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    const settledA = controller.getState();

    const widerMetrics = { ...metrics, nodeWidth: metrics.nodeWidth + 20 };
    controller.update(input(secondId), widerMetrics);
    expect(controller.getState().status).toBe('loading');

    controller.update(input(secondId), metrics);
    const returnedA = controller.getState();
    expect(returnedA).toMatchObject({
      status: 'ready',
      layoutKey: settledA.layoutKey,
      currentCardId: secondId,
      width: 480,
    });

    second.resolve(
      layout(graphs[1] ?? graphs[0] ?? { nodes: [], edges: [] }, 80),
    );
    await Promise.resolve();
    expect(controller.getState()).toBe(returnedA);
  });

  it('keeps settled A when active B rejects after returning to A', async () => {
    const first = deferred<ConnectionsLayout>();
    const second = deferred<ConnectionsLayout>();
    const graphs: ConnectionsLayoutGraph[] = [];
    const runner: ConnectionsLayoutRunner = (graph) => {
      graphs.push(graph);
      return graphs.length === 1 ? first.promise : second.promise;
    };
    const controller = createConnectionsController(input(), metrics, runner);

    controller.update(input(), metrics);
    first.resolve(layout(graphs[0] ?? { nodes: [], edges: [] }));
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));

    controller.update(input(), { ...metrics, layerSpacing: 148 });
    controller.update(input(secondId), metrics);
    const returnedA = controller.getState();

    second.reject(new Error('stale B failure'));
    await Promise.resolve();
    expect(controller.getState()).toBe(returnedA);
    expect(controller.getState().status).toBe('ready');
  });

  it('accepts only C across A to B to C request ordering', async () => {
    const first = deferred<ConnectionsLayout>();
    const second = deferred<ConnectionsLayout>();
    const third = deferred<ConnectionsLayout>();
    const pending = [first, second, third];
    const graphs: ConnectionsLayoutGraph[] = [];
    const runner: ConnectionsLayoutRunner = (graph) => {
      graphs.push(graph);
      const request = pending[graphs.length - 1];
      if (!request) throw new Error('Unexpected layout request');
      return request.promise;
    };
    const controller = createConnectionsController(input(), metrics, runner);

    controller.update(input(), metrics);
    controller.update(input(), { ...metrics, nodeWidth: 220 });
    controller.update(input(secondId), { ...metrics, nodeWidth: 240 });

    third.resolve(
      layout(graphs[2] ?? graphs[0] ?? { nodes: [], edges: [] }, 60),
    );
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    const acceptedC = controller.getState();
    expect(acceptedC).toMatchObject({
      status: 'ready',
      currentCardId: secondId,
      width: 540,
    });

    second.resolve(
      layout(graphs[1] ?? graphs[0] ?? { nodes: [], edges: [] }, 30),
    );
    first.resolve(layout(graphs[0] ?? { nodes: [], edges: [] }, 10));
    await Promise.all([first.promise, second.promise]);
    expect(controller.getState()).toBe(acceptedC);
  });

  it('does not publish success after destroy', async () => {
    const success = deferred<ConnectionsLayout>();
    const controller = createConnectionsController(
      input(),
      metrics,
      () => success.promise,
    );
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.update(input(), metrics);
    const stateBeforeDestroy = controller.getState();
    controller.destroy();
    success.resolve(
      layout({
        nodes: input().nodes.map(({ cardId: id }) => ({ id })),
        edges: input().edges.map(({ sourceCardId, targetCardId }) => ({
          sourceCardId,
          targetCardId,
        })),
      }),
    );
    await success.promise;
    await Promise.resolve();

    expect(controller.getState()).toBe(stateBeforeDestroy);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('does not publish failure after destroy', async () => {
    const failure = deferred<ConnectionsLayout>();
    const controller = createConnectionsController(
      input(),
      metrics,
      () => failure.promise,
    );
    const listener = vi.fn();
    controller.subscribe(listener);

    controller.update(input(), metrics);
    const stateBeforeDestroy = controller.getState();
    controller.destroy();
    failure.reject(new Error('destroyed request failure'));
    await expect(failure.promise).rejects.toThrow('destroyed request failure');
    await Promise.resolve();

    expect(controller.getState()).toBe(stateBeforeDestroy);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('exposes every semantic node through the error fallback', async () => {
    const failure = deferred<ConnectionsLayout>();
    const controller = createConnectionsController(
      input(),
      metrics,
      () => failure.promise,
    );
    controller.update(input(), metrics);
    failure.reject(new Error('layout unavailable'));
    await vi.waitFor(() => expect(controller.getState().status).toBe('error'));

    expect(controller.getState()).toMatchObject({
      status: 'error',
      fallbackItems: [
        { cardId: firstId, title: 'First', current: true },
        { cardId: secondId, title: 'Second', current: false },
      ],
    });
  });
});
