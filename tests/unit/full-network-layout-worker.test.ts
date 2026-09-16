import { describe, expect, it, vi } from 'vitest';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import {
  createFullNetworkLayoutWorkerExecution,
  type FullNetworkLayoutWorkerPort,
} from '@/lib/client/full-network-layout-worker';
import { parseCardId } from '@/lib/domain/id';
import {
  createFullNetworkTopologyFromNumeric,
  defaultFullNetworkLayoutConfiguration,
} from '@/lib/graph/full-network-layout';
import type { FullNetworkLayoutWorkerRequest } from '@/lib/graph/full-network-layout-protocol';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const scope: VaultNotesScope = {
  kind: 'vault',
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

function request(requestId: number): FullNetworkLayoutWorkerRequest {
  return {
    kind: 'layout-full-network',
    requestId,
    topology: createFullNetworkTopologyFromNumeric(
      [parseCardId('01991f20-61d2-7000-8000-000000000001')],
      new Uint32Array(),
      new Uint32Array(),
    ),
    configuration: defaultFullNetworkLayoutConfiguration,
  };
}

class FakeWorker implements FullNetworkLayoutWorkerPort {
  readonly messages: FullNetworkLayoutWorkerRequest[] = [];
  readonly terminate = vi.fn();
  readonly listeners = {
    message: new Set<EventListener>(),
    error: new Set<EventListener>(),
  };

  postMessage(message: FullNetworkLayoutWorkerRequest): void {
    this.messages.push(message);
  }

  addEventListener(type: 'message' | 'error', listener: EventListener): void {
    this.listeners[type].add(listener);
  }

  removeEventListener(
    type: 'message' | 'error',
    listener: EventListener,
  ): void {
    this.listeners[type].delete(listener);
  }

  emitMessage(data: unknown): void {
    const event = new MessageEvent('message', { data });
    for (const listener of this.listeners.message) listener(event);
  }

  emitError(): void {
    const event = new Event('error');
    for (const listener of this.listeners.error) listener(event);
  }
}

describe('scope-bound full-network worker execution', () => {
  it('keeps one worker for sequential layouts and exposes no global cache', async () => {
    const worker = new FakeWorker();
    const createWorker = vi.fn(() => worker);
    const execution = createFullNetworkLayoutWorkerExecution({
      scope,
      createWorker,
    });
    const first = execution.run(request(1));
    expect(execution.hasInFlightRequest()).toBe(true);
    worker.emitMessage({ result: 'first' });
    await expect(first).resolves.toEqual({ result: 'first' });

    const second = execution.run(request(2));
    worker.emitMessage({ result: 'second' });
    await expect(second).resolves.toEqual({ result: 'second' });
    expect(createWorker).toHaveBeenCalledOnce();
    expect(worker.messages.map(({ requestId }) => requestId)).toEqual([1, 2]);
    expect(execution.scope).toEqual(scope);
  });

  it('terminates superseded work and rejects it before creating one replacement', async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const createWorker = vi
      .fn<() => FullNetworkLayoutWorkerPort>()
      .mockReturnValueOnce(firstWorker)
      .mockReturnValueOnce(secondWorker);
    const execution = createFullNetworkLayoutWorkerExecution({
      scope,
      createWorker,
    });
    const first = execution.run(request(1));
    const second = execution.run(request(2));
    await expect(first).rejects.toThrow('cancelled');
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    secondWorker.emitMessage({ requestId: 2 });
    await expect(second).resolves.toEqual({ requestId: 2 });
    expect(execution.hasInFlightRequest()).toBe(false);
  });

  it('rejects worker errors and destroys scope resources idempotently', async () => {
    const worker = new FakeWorker();
    const execution = createFullNetworkLayoutWorkerExecution({
      scope,
      createWorker: () => worker,
    });
    const pending = execution.run(request(1));
    worker.emitError();
    await expect(pending).rejects.toThrow('worker failed');
    expect(worker.terminate).toHaveBeenCalledOnce();

    execution.destroy();
    execution.destroy();
    expect(execution.isDestroyed()).toBe(true);
    await expect(execution.run(request(2))).rejects.toThrow('destroyed');
  });
});
