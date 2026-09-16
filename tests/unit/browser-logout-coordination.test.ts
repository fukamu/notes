/** @vitest-environment happy-dom */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLogoutPurgeRequest,
  parseTabInstanceId,
} from '@/lib/application/logout-coordination';
import {
  createBrowserLogoutCoordinationPlatform,
  createBrowserTabInstanceId,
} from '@/lib/client/browser-logout-coordination';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const originalLocks = Object.getOwnPropertyDescriptor(navigator, 'locks');
const originalBroadcastChannel = Object.getOwnPropertyDescriptor(
  globalThis,
  'BroadcastChannel',
);

afterEach(() => {
  restoreProperty(navigator, 'locks', originalLocks);
  restoreProperty(globalThis, 'BroadcastChannel', originalBroadcastChannel);
  TestBroadcastChannel.reset();
});

describe('browser logout coordination adapter', () => {
  it('creates validated tab ids and transports typed messages', async () => {
    Object.defineProperty(globalThis, 'BroadcastChannel', {
      configurable: true,
      value: TestBroadcastChannel,
    });
    expect(createBrowserTabInstanceId()).toEqual(expect.any(String));
    const platform = createBrowserLogoutCoordinationPlatform();
    const first = platform.openChannel('logout-test');
    const second = platform.openChannel('logout-test');
    if (first.kind !== 'opened' || second.kind !== 'opened') {
      throw new Error('expected channels to open');
    }
    const received = Promise.withResolvers<unknown>();
    second.channel.subscribe(received.resolve);
    const message = createLogoutPurgeRequest(
      {
        accountId: sessionFixtureIds.accountId,
        vaultId: sessionFixtureIds.vaultId,
        sessionId: sessionFixtureIds.sessionId,
        sessionEpoch: sessionFixtureIds.epoch,
      },
      1,
      parseTabInstanceId('00000000-0000-4000-8000-000000000021'),
    );
    expect(first.channel.post(message)).toBe('sent');
    await expect(received.promise).resolves.toEqual(message);
    first.channel.close();
    second.channel.close();
  });

  it('holds and explicitly releases an acquired Web Lock', async () => {
    const request = vi.fn(
      async (
        name: string,
        options: LockOptions,
        callback: (lock: Lock | null) => Promise<void>,
      ) => callback({ name, mode: options.mode ?? 'exclusive' }),
    );
    setLocks({ request });
    const acquired =
      await createBrowserLogoutCoordinationPlatform().acquireLock({
        name: 'runtime-lock',
        mode: 'shared',
        ifAvailable: false,
        timeoutMs: 100,
      });
    expect(acquired.kind).toBe('acquired');
    expect(request).toHaveBeenCalledOnce();
    if (acquired.kind === 'acquired') await acquired.lease.release();
  });

  it('reports contention, timeout, adapter failure, and missing capabilities', async () => {
    setLocks({
      request: async (
        _name: string,
        _options: LockOptions,
        callback: (lock: Lock | null) => Promise<void>,
      ) => callback(null),
    });
    expect(
      await createBrowserLogoutCoordinationPlatform().acquireLock({
        name: 'owner-lock',
        mode: 'exclusive',
        ifAvailable: true,
        timeoutMs: 100,
      }),
    ).toEqual({ kind: 'failed', reason: 'contended' });

    setLocks({
      request: async () => {
        throw new Error('lock adapter failed');
      },
    });
    expect(
      await createBrowserLogoutCoordinationPlatform().acquireLock({
        name: 'owner-lock',
        mode: 'exclusive',
        ifAvailable: true,
        timeoutMs: 100,
      }),
    ).toEqual({ kind: 'failed', reason: 'adapter-failure' });

    setLocks({
      request: (_name: string, options: LockOptions) =>
        new Promise<void>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error()), {
            once: true,
          });
        }),
    });
    expect(
      await createBrowserLogoutCoordinationPlatform().acquireLock({
        name: 'runtime-lock',
        mode: 'exclusive',
        ifAvailable: false,
        timeoutMs: 1,
      }),
    ).toEqual({ kind: 'failed', reason: 'timeout' });

    restoreProperty(navigator, 'locks', undefined);
    expect(
      await createBrowserLogoutCoordinationPlatform().acquireLock({
        name: 'runtime-lock',
        mode: 'shared',
        ifAvailable: false,
        timeoutMs: 100,
      }),
    ).toEqual({ kind: 'failed', reason: 'unsupported-capability' });
  });

  it('rejects an invalid timeout before calling Web Locks', async () => {
    const request = vi.fn();
    setLocks({ request });
    expect(
      await createBrowserLogoutCoordinationPlatform().acquireLock({
        name: 'runtime-lock',
        mode: 'shared',
        ifAvailable: false,
        timeoutMs: 0,
      }),
    ).toEqual({ kind: 'failed', reason: 'adapter-failure' });
    expect(request).not.toHaveBeenCalled();
  });
});

function setLocks(value: object): void {
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value,
  });
}

function restoreProperty(
  target: object,
  key: PropertyKey,
  descriptor: PropertyDescriptor | undefined,
): void {
  if (descriptor) Object.defineProperty(target, key, descriptor);
  else Reflect.deleteProperty(target, key);
}

class TestBroadcastChannel {
  private static readonly channels = new Set<TestBroadcastChannel>();
  private readonly listeners = new Set<
    (event: MessageEvent<unknown>) => void
  >();

  constructor(private readonly name: string) {
    TestBroadcastChannel.channels.add(this);
  }

  static reset(): void {
    TestBroadcastChannel.channels.clear();
  }

  postMessage(message: unknown): void {
    for (const channel of TestBroadcastChannel.channels) {
      if (channel === this || channel.name !== this.name) continue;
      const event = new MessageEvent('message', { data: message });
      for (const listener of channel.listeners) listener(event);
    }
  }

  addEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (type === 'message') this.listeners.add(listener);
  }

  removeEventListener(
    type: 'message',
    listener: (event: MessageEvent<unknown>) => void,
  ): void {
    if (type === 'message') this.listeners.delete(listener);
  }

  close(): void {
    this.listeners.clear();
    TestBroadcastChannel.channels.delete(this);
  }
}
