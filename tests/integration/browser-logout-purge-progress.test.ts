import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createLogoutPurgeProgress } from '@/lib/application/logout-purge';
import {
  readLogoutPurgeProgress,
  startOrResumeLogoutPurge,
} from '@/lib/application/logout-purge-progress';
import {
  LOGOUT_PURGE_CONTROL_DATABASE_NAME,
  createBrowserLogoutPurgeProgressPort,
} from '@/lib/client/browser-logout-purge-progress';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const generation = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

afterEach(() => deleteControlDatabase());

describe('browser logout purge progress adapter', () => {
  it('persists the versioned marker across adapter instances and clears by CAS', async () => {
    const first = createBrowserLogoutPurgeProgressPort();
    await expect(startOrResumeLogoutPurge(generation, first)).resolves.toEqual({
      kind: 'started',
      progress: createLogoutPurgeProgress(generation),
    });

    const reloaded = createBrowserLogoutPurgeProgressPort();
    await expect(readLogoutPurgeProgress(reloaded)).resolves.toEqual({
      kind: 'loaded',
      progress: createLogoutPurgeProgress(generation),
    });
    await expect(
      reloaded.clear({ generation, expectedRevision: 99 }),
    ).resolves.toBe(false);
    await expect(
      reloaded.clear({ generation, expectedRevision: 1 }),
    ).resolves.toBe(true);
    await expect(readLogoutPurgeProgress(first)).resolves.toEqual({
      kind: 'none',
    });
  });

  it('allows only one concurrent create transaction', async () => {
    const first = createBrowserLogoutPurgeProgressPort();
    const second = createBrowserLogoutPurgeProgressPort();
    const results = await Promise.all([
      first.write({
        kind: 'create',
        progress: createLogoutPurgeProgress(generation),
      }),
      second.write({
        kind: 'create',
        progress: createLogoutPurgeProgress(generation),
      }),
    ]);

    expect(results.filter((result) => result === true)).toHaveLength(1);
    expect(results.filter((result) => result === false)).toHaveLength(1);
  });

  it.each([
    [{ invalid: true }, 'invalid-marker'],
    [{ schemaVersion: 'logout-purge/v2' }, 'unsupported-version'],
  ] as const)('fails closed for %s progress', async (marker, reason) => {
    await putRawMarker(marker);
    const port = createBrowserLogoutPurgeProgressPort();

    await expect(readLogoutPurgeProgress(port)).resolves.toEqual({
      kind: 'recovery-required',
      reason,
    });
    await expect(
      port.write({
        kind: 'replace',
        expectedRevision: 1,
        progress: createLogoutPurgeProgress(generation),
      }),
    ).resolves.toBe(false);
  });
});

function deleteControlDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(
      LOGOUT_PURGE_CONTROL_DATABASE_NAME,
    );
    request.addEventListener('success', () => resolve(), { once: true });
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    });
    request.addEventListener(
      'blocked',
      () => reject(new Error('control database deletion blocked')),
      { once: true },
    );
  });
}

async function putRawMarker(marker: unknown): Promise<void> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(LOGOUT_PURGE_CONTROL_DATABASE_NAME, 1);
    request.addEventListener('upgradeneeded', () => {
      request.result.createObjectStore('logout-purge');
    });
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    });
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    });
  });
  try {
    const transaction = database.transaction('logout-purge', 'readwrite');
    transaction.objectStore('logout-purge').put(marker, 'current');
    await new Promise<void>((resolve, reject) => {
      transaction.addEventListener('complete', () => resolve(), {
        once: true,
      });
      transaction.addEventListener('error', () => reject(transaction.error), {
        once: true,
      });
      transaction.addEventListener('abort', () => reject(transaction.error), {
        once: true,
      });
    });
  } finally {
    database.close();
  }
}
