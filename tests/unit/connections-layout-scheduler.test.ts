import { describe, expect, it, vi } from 'vitest';
import {
  ConnectionsLayoutSupersededError,
  createConnectionsLayoutScheduler,
} from '@/lib/client/connections-layout-scheduler';
import type { ConnectionsLayout } from '@/lib/graph/elk-layout';

const layout: ConnectionsLayout = {
  width: 1,
  height: 1,
  nodes: [],
  edges: [],
};

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  let rejectPromise: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

describe('connections latest-only layout scheduler', () => {
  it('runs one active request and replaces the pending request with the latest', async () => {
    const scheduler = createConnectionsLayoutScheduler();
    const first = deferred<ConnectionsLayout>();
    const third = deferred<ConnectionsLayout>();
    const firstOperation = vi.fn(() => first.promise);
    const secondOperation = vi.fn(async () => layout);
    const thirdOperation = vi.fn(() => third.promise);

    scheduler.desire('A');
    const requestA = scheduler.schedule('A', firstOperation);
    await Promise.resolve();
    scheduler.desire('B');
    const requestB = scheduler.schedule('B', secondOperation);
    void requestB.catch(() => undefined);
    scheduler.desire('C');
    const requestC = scheduler.schedule('C', thirdOperation);
    await expect(requestB).rejects.toBeInstanceOf(
      ConnectionsLayoutSupersededError,
    );
    expect(firstOperation).toHaveBeenCalledOnce();
    expect(secondOperation).not.toHaveBeenCalled();
    expect(thirdOperation).not.toHaveBeenCalled();

    first.resolve(layout);
    await expect(requestA).resolves.toBe(layout);
    await vi.waitFor(() => expect(thirdOperation).toHaveBeenCalledOnce());
    third.resolve(layout);
    await expect(requestC).resolves.toBe(layout);
  });

  it('shares the same active key and drops a queued key when A becomes desired again', async () => {
    const scheduler = createConnectionsLayoutScheduler();
    const first = deferred<ConnectionsLayout>();
    const firstOperation = vi.fn(() => first.promise);
    const duplicateOperation = vi.fn(async () => layout);
    const secondOperation = vi.fn(async () => layout);

    scheduler.desire('A');
    const firstA = scheduler.schedule('A', firstOperation);
    await Promise.resolve();
    scheduler.desire('B');
    const requestB = scheduler.schedule('B', secondOperation);
    void requestB.catch(() => undefined);
    scheduler.desire('A');
    const secondA = scheduler.schedule('A', duplicateOperation);

    await expect(requestB).rejects.toBeInstanceOf(
      ConnectionsLayoutSupersededError,
    );
    expect(secondA).toBe(firstA);
    expect(duplicateOperation).not.toHaveBeenCalled();
    expect(secondOperation).not.toHaveBeenCalled();
    first.resolve(layout);
    await expect(firstA).resolves.toBe(layout);
  });

  it('settles active and pending requests when reset', async () => {
    const scheduler = createConnectionsLayoutScheduler();
    const active = deferred<ConnectionsLayout>();
    scheduler.desire('A');
    const requestA = scheduler.schedule('A', () => active.promise);
    await Promise.resolve();
    scheduler.desire('B');
    const requestB = scheduler.schedule('B', async () => layout);
    const resetError = new Error('scope reset');

    expect(scheduler.reset(resetError)).toBe(2);
    await expect(requestA).rejects.toBe(resetError);
    await expect(requestB).rejects.toBe(resetError);
    await expect(scheduler.schedule('C', async () => layout)).rejects.toBe(
      resetError,
    );
    active.resolve(layout);
    await Promise.resolve();
  });
});
