import { describe, expect, it, vi } from 'vitest';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import {
  LEGACY_NOTES_SCOPE,
  type NotesScope,
} from '@/lib/application/notes-runtime';
import {
  createFullNetworkLayoutController,
  transitionFullNetworkLayout,
  type FullNetworkLayoutExecutionPort,
  type FullNetworkLayoutControllerState,
} from '@/lib/application/full-network-layout-controller';
import type { ConnectionsInputModel } from '@/lib/graph/connections-contract';
import { layoutFullNetworkTopology } from '@/lib/graph/full-network-layout';
import type {
  FullNetworkLayoutWorkerRequest,
  FullNetworkLayoutWorkerResponse,
} from '@/lib/graph/full-network-layout-protocol';
import { fixtureCardId } from '@/tests/fixtures/ids';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const firstId = fixtureCardId('full-controller-first');
const secondId = fixtureCardId('full-controller-second');
const thirdId = fixtureCardId('full-controller-third');

const scope: VaultNotesScope = {
  kind: 'vault',
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

function model(
  currentCardId = firstId,
  includeSecondEdge = false,
): ConnectionsInputModel {
  const nodeIds = [firstId, secondId, thirdId];
  return {
    currentCardId,
    nodes: nodeIds.map((cardId, index) => ({
      cardId,
      displayLabel: `#${index + 1}`,
      title: `Title ${index + 1}`,
      accessibleName: `Card ${index + 1}`,
      current: cardId === currentCardId,
    })),
    edges: [
      {
        sourceCardId: firstId,
        targetCardId: secondId,
        accessibleName: 'first to second',
      },
      ...(includeSecondEdge
        ? [
            {
              sourceCardId: secondId,
              targetCardId: thirdId,
              accessibleName: 'second to third',
            },
          ]
        : []),
    ],
  };
}

function completed(
  request: FullNetworkLayoutWorkerRequest,
): FullNetworkLayoutWorkerResponse {
  return {
    kind: 'full-network-layout-completed',
    requestId: request.requestId,
    topologyKey: request.topology.structuralKey,
    layout: layoutFullNetworkTopology(request.topology, request.configuration),
  };
}

function execution(
  run: FullNetworkLayoutExecutionPort['run'],
  executionScope: NotesScope = scope,
) {
  const cancel = vi.fn<() => void>();
  const destroy = vi.fn<() => void>();
  return {
    scope: executionScope,
    run,
    cancel,
    destroy,
  } satisfies FullNetworkLayoutExecutionPort;
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

describe('scope-bound full-network layout controller', () => {
  it('does not request layout for current-card or title-only changes', async () => {
    const run = vi.fn<FullNetworkLayoutExecutionPort['run']>(async (request) =>
      completed(request),
    );
    const controller = createFullNetworkLayoutController({
      scope,
      execution: execution(run),
    });
    controller.update(model());
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));

    const renamed = model(secondId);
    const firstNode = renamed.nodes[0];
    if (!firstNode) throw new Error('Fixture omitted first node');
    renamed.nodes[0] = {
      ...firstNode,
      title: 'Renamed without topology change',
    };
    controller.update(renamed);
    const ready = controller.getState();
    expect(ready.status).toBe('ready');
    if (ready.status !== 'ready') return;
    expect(ready.ready.input.currentCardId).toBe(secondId);
    expect(ready.ready.input.nodes[0]?.title).toBe(
      'Renamed without topology change',
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps the complete previous layout while a topology refresh is in flight', async () => {
    const refresh = deferred<unknown>();
    const run = vi
      .fn<FullNetworkLayoutExecutionPort['run']>()
      .mockImplementationOnce(async (request) => completed(request))
      .mockImplementationOnce(() => refresh.promise);
    const controller = createFullNetworkLayoutController({
      scope,
      execution: execution(run),
    });
    controller.update(model());
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    const first = controller.getState();
    if (first.status !== 'ready') throw new Error('Expected ready state');

    controller.update(model(firstId, true));
    const refreshing = controller.getState();
    expect(refreshing.status).toBe('refreshing');
    if (refreshing.status !== 'refreshing') return;
    expect(refreshing.ready).toBe(first.ready);
    const request = run.mock.calls[1]?.[0];
    if (!request) throw new Error('Refresh request was not captured');
    refresh.resolve(completed(request));
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    const ready = controller.getState();
    expect(ready.status === 'ready' && ready.ready.layout.edgeCount).toBe(2);
  });

  it('cancels superseded work and ignores its late result', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const run = vi
      .fn<FullNetworkLayoutExecutionPort['run']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const port = execution(run);
    const controller = createFullNetworkLayoutController({
      scope,
      execution: port,
    });
    controller.update(model());
    controller.update(model(firstId, true));
    expect(port.cancel).toHaveBeenCalledOnce();

    const firstRequest = run.mock.calls[0]?.[0];
    const secondRequest = run.mock.calls[1]?.[0];
    if (!firstRequest || !secondRequest) throw new Error('Missing requests');
    first.resolve(completed(firstRequest));
    await Promise.resolve();
    expect(controller.getState().status).toBe('loading');
    second.resolve(completed(secondRequest));
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    const state = controller.getState();
    expect(state.status === 'ready' && state.ready.layout.edgeCount).toBe(2);
  });

  it('fails closed on invalid output, retries, and never discards the reason', async () => {
    const run = vi
      .fn<FullNetworkLayoutExecutionPort['run']>()
      .mockResolvedValueOnce({ kind: 'malformed' })
      .mockImplementationOnce(async (request) => completed(request));
    const controller = createFullNetworkLayoutController({
      scope,
      execution: execution(run),
    });
    controller.update(model());
    await vi.waitFor(() => expect(controller.getState().status).toBe('error'));
    expect(controller.getState()).toMatchObject({
      status: 'error',
      reason: 'invalid-response',
      ready: null,
    });
    controller.retry();
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('rejects a different Vault/session scope and destroys idempotently', () => {
    const otherScope: VaultNotesScope = {
      ...scope,
      vaultId: sessionFixtureIds.otherVaultId,
      sessionId: sessionFixtureIds.nextSessionId,
      sessionEpoch: sessionFixtureIds.nextEpoch,
    };
    expect(() =>
      createFullNetworkLayoutController({
        scope,
        execution: execution(async () => ({}), otherScope),
      }),
    ).toThrow('scope mismatch');

    const port = execution(async (request) => completed(request));
    const controller = createFullNetworkLayoutController({
      scope,
      execution: port,
    });
    controller.destroy();
    controller.destroy();
    controller.update(model());
    expect(controller.getState()).toEqual({ status: 'destroyed' });
    expect(port.cancel).toHaveBeenCalledOnce();
    expect(port.destroy).toHaveBeenCalledOnce();
  });

  it('accepts the exact legacy runtime scope without weakening scope checks', async () => {
    const run = vi.fn<FullNetworkLayoutExecutionPort['run']>(async (request) =>
      completed(request),
    );
    const controller = createFullNetworkLayoutController({
      scope: LEGACY_NOTES_SCOPE,
      execution: execution(run, LEGACY_NOTES_SCOPE),
    });

    controller.update(model());
    await vi.waitFor(() => expect(controller.getState().status).toBe('ready'));
    expect(run).toHaveBeenCalledOnce();
  });

  it('keeps the pure transition bounded to one ready and one in-flight generation', () => {
    const topology = createTopologyForTransition();
    const initial: FullNetworkLayoutControllerState = { status: 'idle' };
    const loading = transitionFullNetworkLayout(initial, {
      type: 'topology-observed',
      input: model(),
      topology,
      requestId: 1,
      configuration: requestConfiguration(),
    });
    expect(loading.state.status).toBe('loading');
    expect(loading.command).toMatchObject({
      kind: 'start',
      cancelInFlight: false,
    });
    const superseded = transitionFullNetworkLayout(loading.state, {
      type: 'topology-observed',
      input: model(firstId, true),
      topology: createTopologyForTransition(true),
      requestId: 2,
      configuration: requestConfiguration(),
    });
    expect(superseded.state.status).toBe('loading');
    expect(superseded.command).toMatchObject({
      kind: 'start',
      cancelInFlight: true,
    });
  });
});

function createTopologyForTransition(withSecondEdge = false) {
  const input = model(firstId, withSecondEdge);
  return {
    structuralKey: `test-${withSecondEdge}`,
    nodeIds: input.nodes.map(({ cardId }) => cardId),
    sources: new Uint32Array(withSecondEdge ? [0, 1] : [0]),
    targets: new Uint32Array(withSecondEdge ? [1, 2] : [1]),
  };
}

function requestConfiguration() {
  return {
    version: 1,
    cellWidth: 16,
    cellHeight: 12,
    componentGap: 48,
    isolatedComponentGap: 4,
    shelfAspectRatio: 1.25,
  } as const;
}
