'use client';

import {
  inspectLogoutPurgeProgress,
  sameLogoutPurgeGeneration,
} from '@/lib/application/logout-purge';
import type {
  LogoutPurgeProgressClear,
  LogoutPurgeProgressPort,
  LogoutPurgeProgressWrite,
} from '@/lib/application/logout-purge-progress';

export const LOGOUT_PURGE_CONTROL_DATABASE_NAME =
  'fukamu-notes:control:v1' as const;
const CONTROL_DATABASE_VERSION = 1;
const PROGRESS_STORE_NAME = 'logout-purge';
const CURRENT_MARKER_KEY = 'current';

/**
 * Stores the global non-content logout marker outside every Vault database.
 * Each compare-and-swap is one IndexedDB transaction across tabs.
 */
export function createBrowserLogoutPurgeProgressPort(
  factory: IDBFactory = indexedDB,
): LogoutPurgeProgressPort {
  return {
    async read() {
      const database = await openControlDatabase(factory);
      try {
        const transaction = database.transaction(
          PROGRESS_STORE_NAME,
          'readonly',
        );
        const marker = await requestValue(
          transaction.objectStore(PROGRESS_STORE_NAME).get(CURRENT_MARKER_KEY),
        );
        await transactionCompletion(transaction);
        return marker;
      } finally {
        database.close();
      }
    },
    write: (input) => writeMarker(factory, input),
    clear: (input) => clearMarker(factory, input),
  };
}

async function writeMarker(
  factory: IDBFactory,
  input: LogoutPurgeProgressWrite,
): Promise<unknown> {
  const database = await openControlDatabase(factory);
  try {
    const transaction = database.transaction(PROGRESS_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(PROGRESS_STORE_NAME);
    const marker = await requestValue(store.get(CURRENT_MARKER_KEY));
    if (!canWrite(marker, input)) {
      transaction.abort();
      await ignoreAbort(transaction);
      return false;
    }
    store.put(input.progress, CURRENT_MARKER_KEY);
    await transactionCompletion(transaction);
    return true;
  } finally {
    database.close();
  }
}

async function clearMarker(
  factory: IDBFactory,
  input: LogoutPurgeProgressClear,
): Promise<unknown> {
  const database = await openControlDatabase(factory);
  try {
    const transaction = database.transaction(PROGRESS_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(PROGRESS_STORE_NAME);
    const marker = await requestValue(store.get(CURRENT_MARKER_KEY));
    if (!canClear(marker, input)) {
      transaction.abort();
      await ignoreAbort(transaction);
      return false;
    }
    store.delete(CURRENT_MARKER_KEY);
    await transactionCompletion(transaction);
    return true;
  } finally {
    database.close();
  }
}

function canWrite(marker: unknown, input: LogoutPurgeProgressWrite): boolean {
  switch (input.kind) {
    case 'create':
      return marker === undefined;
    case 'replace': {
      const current = inspectLogoutPurgeProgress(marker);
      return (
        current.kind === 'loaded' &&
        current.progress.revision === input.expectedRevision &&
        sameLogoutPurgeGeneration(current.progress, input.progress)
      );
    }
  }
}

function canClear(marker: unknown, input: LogoutPurgeProgressClear): boolean {
  const current = inspectLogoutPurgeProgress(marker);
  return (
    current.kind === 'loaded' &&
    current.progress.revision === input.expectedRevision &&
    sameLogoutPurgeGeneration(current.progress, input.generation)
  );
}

function openControlDatabase(factory: IDBFactory): Promise<IDBDatabase> {
  let request: IDBOpenDBRequest;
  try {
    request = factory.open(
      LOGOUT_PURGE_CONTROL_DATABASE_NAME,
      CONTROL_DATABASE_VERSION,
    );
  } catch (error) {
    return Promise.reject(error);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (reason: unknown) => {
      if (settled) return;
      settled = true;
      reject(reason);
    };
    request.addEventListener('upgradeneeded', () => {
      if (!request.result.objectStoreNames.contains(PROGRESS_STORE_NAME)) {
        request.result.createObjectStore(PROGRESS_STORE_NAME);
      }
    });
    request.addEventListener(
      'success',
      () => {
        if (settled) {
          request.result.close();
          return;
        }
        settled = true;
        resolve(request.result);
      },
      { once: true },
    );
    request.addEventListener('blocked', () => fail(new Error('blocked')), {
      once: true,
    });
    request.addEventListener('error', () => fail(request.error), {
      once: true,
    });
  });
}

function requestValue(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => {
      const value: unknown = request.result;
      resolve(value);
    });
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    });
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
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

async function ignoreAbort(transaction: IDBTransaction): Promise<void> {
  try {
    await transactionCompletion(transaction);
  } catch {
    // An intentional CAS mismatch abort leaves the marker unchanged.
  }
}
