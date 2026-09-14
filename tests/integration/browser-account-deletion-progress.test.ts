import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  accountDeletionIdempotencyKeyDecoder,
  createAccountDeletionHandoff,
  type AccountDeletionHandoff,
} from '@/lib/application/account-deletion-handoff';
import { createLogoutPurgeProgress } from '@/lib/application/logout-purge';
import { createBrowserAccountDeletionProgressPort } from '@/lib/client/browser-account-deletion-progress';
import {
  BROWSER_CONTROL_DATABASE_NAME,
  BROWSER_CONTROL_DATABASE_VERSION,
} from '@/lib/client/browser-control-database';
import { createBrowserLogoutPurgeProgressPort } from '@/lib/client/browser-logout-purge-progress';
import { decodeOrThrow } from '@/lib/codec/core';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const generation = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};
const key = decodeOrThrow(
  accountDeletionIdempotencyKeyDecoder,
  'I'.repeat(43),
  'fixture idempotency key',
);

afterEach(() => deleteControlDatabase());

describe('browser account deletion progress adapter', () => {
  it('persists across adapter instances and requires generation/revision CAS', async () => {
    const starting = createAccountDeletionHandoff(generation, key);
    const first = createBrowserAccountDeletionProgressPort();
    await expect(
      first.write({ kind: 'create', handoff: starting }),
    ).resolves.toBe(true);
    await expect(
      createBrowserAccountDeletionProgressPort().read(),
    ).resolves.toEqual(starting);

    const next: AccountDeletionHandoff = {
      ...starting,
      revision: 2,
      kind: 'purge-pending',
      server: { kind: 'completed' },
    };
    await expect(
      first.write({ kind: 'replace', expectedRevision: 99, handoff: next }),
    ).resolves.toBe(false);
    await expect(
      first.write({ kind: 'replace', expectedRevision: 1, handoff: next }),
    ).resolves.toBe(true);
    await expect(
      first.clear({ generation, expectedRevision: 1 }),
    ).resolves.toBe(false);
    await expect(
      first.clear({ generation, expectedRevision: 2 }),
    ).resolves.toBe(true);
    await expect(first.read()).resolves.toBeUndefined();
  });

  it('coexists transactionally with the existing logout purge marker', async () => {
    const deletion = createAccountDeletionHandoff(generation, key);
    const logout = createLogoutPurgeProgress(generation);
    const deletionPort = createBrowserAccountDeletionProgressPort();
    const logoutPort = createBrowserLogoutPurgeProgressPort();

    await expect(
      Promise.all([
        deletionPort.write({ kind: 'create', handoff: deletion }),
        logoutPort.write({ kind: 'create', progress: logout }),
      ]),
    ).resolves.toEqual([true, true]);
    await expect(deletionPort.read()).resolves.toEqual(deletion);
    await expect(logoutPort.read()).resolves.toEqual(logout);
  });

  it('upgrades the pre-existing logout-only control database without losing its marker', async () => {
    const logout = createLogoutPurgeProgress(generation);
    await putVersionOneLogoutMarker(logout);

    await expect(
      createBrowserAccountDeletionProgressPort().read(),
    ).resolves.toBeUndefined();
    await expect(
      createBrowserLogoutPurgeProgressPort().read(),
    ).resolves.toEqual(logout);
  });
});

function deleteControlDatabase(): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(BROWSER_CONTROL_DATABASE_NAME);
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

async function putVersionOneLogoutMarker(marker: unknown): Promise<void> {
  expect(BROWSER_CONTROL_DATABASE_VERSION).toBe(2);
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(BROWSER_CONTROL_DATABASE_NAME, 1);
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
    await transactionDone(transaction);
  } finally {
    database.close();
  }
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), {
      once: true,
    });
    transaction.addEventListener('error', () => reject(transaction.error), {
      once: true,
    });
  });
}
