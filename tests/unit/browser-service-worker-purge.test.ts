import { describe, expect, it } from 'vitest';
import {
  createServiceWorkerLogoutCachePurge,
  verifyServiceWorkerCaches,
  type ServiceWorkerLogoutCachePlatform,
  type ServiceWorkerLogoutCachePlatformResult,
} from '@/lib/client/browser-service-worker-purge';

function platform(input?: {
  result?: ServiceWorkerLogoutCachePlatformResult;
  cacheNames?: unknown;
  throwOnRead?: boolean;
}): ServiceWorkerLogoutCachePlatform {
  return {
    async requestPurge() {
      return (
        input?.result ?? {
          kind: 'received',
          acknowledgement: {
            type: 'LOGOUT_CACHE_PURGE_RESULT',
            status: 'purged',
          },
        }
      );
    },
    async readCacheNames() {
      if (input?.throwOnRead) throw new Error('cache read failed');
      return input?.cacheNames ?? ['unrelated-cache'];
    },
  };
}

describe('browser Service Worker logout cache purge', () => {
  it('accepts a valid acknowledgement only after FUKAMU caches are absent', async () => {
    const purge = createServiceWorkerLogoutCachePurge(platform(), 100);
    await expect(purge()).resolves.toEqual({ kind: 'completed' });

    expect(verifyServiceWorkerCaches(['unrelated-cache'])).toEqual({
      kind: 'completed',
    });
    expect(verifyServiceWorkerCaches(['fukamu-notes-static-v3'])).toEqual({
      kind: 'failed',
      reason: 'verification-failed',
    });
  });

  it.each([
    [
      { kind: 'received', acknowledgement: { status: 'purged' } },
      'verification-failed',
    ],
    [{ kind: 'failed', reason: 'timeout' }, 'timeout'],
    [
      { kind: 'failed', reason: 'unsupported-capability' },
      'unsupported-capability',
    ],
  ] as const)('normalizes %s as %s', async (result, reason) => {
    const purge = createServiceWorkerLogoutCachePurge(
      platform({ result }),
      100,
    );
    await expect(purge()).resolves.toEqual({ kind: 'failed', reason });
  });

  it('does not accept a cache read failure or a remaining cache', async () => {
    await expect(
      createServiceWorkerLogoutCachePurge(
        platform({ cacheNames: ['fukamu-notes-private'] }),
        100,
      )(),
    ).resolves.toEqual({ kind: 'failed', reason: 'verification-failed' });
    await expect(
      createServiceWorkerLogoutCachePurge(
        platform({ throwOnRead: true }),
        100,
      )(),
    ).resolves.toEqual({ kind: 'failed', reason: 'adapter-failure' });
  });
});
