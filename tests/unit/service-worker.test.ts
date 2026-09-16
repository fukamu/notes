import { readFile } from 'node:fs/promises';
import { createContext, runInContext, type Context } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type FakeCacheState = {
  keys: string[];
  deleted: string[];
  added: string[][];
  timeline: string[];
  failDelete: boolean;
};

type WorkerHarness = {
  context: Context;
  state: FakeCacheState;
};

async function loadWorkerHarness(
  initialKeys: string[] = [],
): Promise<WorkerHarness> {
  const source = await readFile(
    new URL('../../public/sw.js', import.meta.url),
    'utf8',
  );
  const state: FakeCacheState = {
    keys: [...initialKeys],
    deleted: [],
    added: [],
    timeline: [],
    failDelete: false,
  };
  const cache = {
    addAll: async (urls: string[]) => {
      state.added.push([...urls]);
    },
    match: async () => undefined,
    put: async () => undefined,
  };
  const context = createContext({
    URL,
    Request,
    Response,
    fetch: vi.fn(),
    caches: {
      open: async () => cache,
      keys: async () => [...state.keys],
      delete: async (key: string) => {
        if (state.failDelete) throw new Error('delete failed');
        state.deleted.push(key);
        state.timeline.push(`delete:${key}`);
        state.keys = state.keys.filter((candidate) => candidate !== key);
        return true;
      },
    },
    addEventListener: () => undefined,
    clients: { claim: async () => undefined },
    location: { origin: 'https://notes.example' },
    skipWaiting: async () => undefined,
  });
  runInContext(
    `${source}\nglobalThis.__policy = cachePolicyForRequest;\nglobalThis.__urls = cacheUrlsFromMessage;\nglobalThis.__command = workerCommandFromMessage;\nglobalThis.__handle = handleWorkerCommand;\nglobalThis.__deleteStale = deleteStaleNotesCaches;`,
    context,
  );
  return { context, state };
}

function callWorkerFunction(
  context: Context,
  name: string,
  ...input: unknown[]
): unknown {
  const value: unknown = context[name];
  if (typeof value !== 'function') {
    throw new Error(`Service Worker did not expose ${name}`);
  }
  const result: unknown = Reflect.apply(value, undefined, input);
  return result;
}

describe('Service Worker cache policy', () => {
  it('allows only explicit static resources and app-shell navigations', async () => {
    const { context } = await loadWorkerHarness();
    const policy = (method: string, url: string, mode = 'no-cors') =>
      callWorkerFunction(
        context,
        '__policy',
        { method, url, mode },
        'https://notes.example',
      );

    expect(policy('GET', '/_next/static/chunks/app-Ab12.js')).toEqual({
      kind: 'immutable-static',
    });
    expect(policy('GET', '/manifest.webmanifest')).toEqual({
      kind: 'immutable-static',
    });
    expect(policy('GET', '/', 'navigate')).toEqual({
      kind: 'app-shell-navigation',
    });
    expect(policy('GET', '/history', 'navigate')).toEqual({
      kind: 'app-shell-navigation',
    });
    expect(policy('GET', '/cards/card-id/connections', 'navigate')).toEqual({
      kind: 'app-shell-navigation',
    });

    const denied = [
      ['POST', '/_next/static/chunks/app-Ab12.js', 'no-cors'],
      ['GET', 'https://other.example/static.js', 'no-cors'],
      ['GET', '/api/sync', 'cors'],
      ['GET', '/auth/callback', 'navigate'],
      ['GET', '/oauth/callback', 'navigate'],
      ['GET', '/billing', 'navigate'],
      ['GET', '/checkout', 'navigate'],
      ['GET', '/account/billing', 'navigate'],
      ['GET', '/legal/privacy', 'navigate'],
      ['GET', '/account', 'navigate'],
      ['GET', '/cards/card-id?token=secret', 'navigate'],
      ['GET', '/_next/static/chunks/app.js?user=1', 'no-cors'],
      ['GET', '/cards/card-id', 'cors'],
      ['GET', '/unlisted.js', 'no-cors'],
    ] as const;
    for (const [method, url, mode] of denied) {
      expect(policy(method, url, mode)).toEqual({ kind: 'network-only' });
    }
  });

  it('decodes CACHE_URLS as a non-personal static allowlist', async () => {
    const { context } = await loadWorkerHarness();
    const result = callWorkerFunction(context, '__urls', {
      type: 'CACHE_URLS',
      urls: [
        '/',
        '/manifest.webmanifest',
        '/_next/static/chunks/app-Ab12.js',
        '/_next/static/chunks/app-Ab12.js',
        '/cards/card-id',
        '/api/sync',
        '/favicon.svg?user=1',
        'https://other.example/static.js',
        42,
      ],
    });

    expect(result).toEqual([
      '/',
      '/manifest.webmanifest',
      '/_next/static/chunks/app-Ab12.js',
    ]);
    for (const data of [
      null,
      { type: 'OTHER', urls: [] },
      { type: 'CACHE_URLS', urls: '/' },
    ]) {
      expect(callWorkerFunction(context, '__urls', data)).toBeUndefined();
    }
  });
});

describe('Service Worker cache migration', () => {
  it('deletes only stale FUKAMU caches during activation', async () => {
    const { context, state } = await loadWorkerHarness([
      'fukamu-notes-v2',
      'fukamu-notes-static-v3',
      'unrelated-cache',
    ]);

    await Promise.resolve(callWorkerFunction(context, '__deleteStale'));

    expect(state.keys).toEqual(['fukamu-notes-static-v3', 'unrelated-cache']);
    expect(state.deleted).toEqual(['fukamu-notes-v2']);
  });
});

describe('Service Worker logout cache purge', () => {
  it('acknowledges only after every FUKAMU cache is absent', async () => {
    const { context, state } = await loadWorkerHarness([
      'fukamu-notes-v2',
      'fukamu-notes-static-v3',
      'unrelated-cache',
    ]);
    const command = callWorkerFunction(context, '__command', {
      type: 'LOGOUT_CACHE_PURGE',
    });
    const replies: unknown[] = [];
    const pending = callWorkerFunction(context, '__handle', command, {
      postMessage: (message: unknown) => {
        state.timeline.push('ack');
        replies.push(message);
      },
    });

    await Promise.resolve(pending);

    expect(state.keys).toEqual(['unrelated-cache']);
    expect(state.deleted).toEqual([
      'fukamu-notes-v2',
      'fukamu-notes-static-v3',
    ]);
    expect(state.timeline).toEqual([
      'delete:fukamu-notes-v2',
      'delete:fukamu-notes-static-v3',
      'ack',
    ]);
    expect(replies).toEqual([
      { type: 'LOGOUT_CACHE_PURGE_RESULT', status: 'purged' },
    ]);
  });

  it('rejects deletion failures without sending a success acknowledgement', async () => {
    const { context, state } = await loadWorkerHarness([
      'fukamu-notes-static-v3',
    ]);
    state.failDelete = true;
    const command = callWorkerFunction(context, '__command', {
      type: 'LOGOUT_CACHE_PURGE',
    });
    const postMessage = vi.fn();

    await expect(
      Promise.resolve(
        callWorkerFunction(context, '__handle', command, { postMessage }),
      ),
    ).rejects.toThrow('delete failed');
    expect(postMessage).not.toHaveBeenCalled();
  });

  it('rejects untrusted purge-like messages', async () => {
    const { context } = await loadWorkerHarness();
    for (const data of [
      null,
      'LOGOUT_CACHE_PURGE',
      {},
      { type: 'LOGOUT_CACHE_PURGES' },
      { type: 'CACHE_URLS', urls: 'not-an-array' },
    ]) {
      expect(callWorkerFunction(context, '__command', data)).toBeUndefined();
    }
  });
});
