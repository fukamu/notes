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
import {
  BROWSER_CONTROL_DATABASE_NAME,
  CURRENT_CONTROL_MARKER_KEY,
  LOGOUT_PURGE_CONTROL_STORE,
  abortBrowserControlTransaction,
  browserControlRequestValue,
  browserControlTransactionCompletion,
  openBrowserControlDatabase,
} from '@/lib/client/browser-control-database';

export const LOGOUT_PURGE_CONTROL_DATABASE_NAME = BROWSER_CONTROL_DATABASE_NAME;

/**
 * Stores the global non-content logout marker outside every Vault database.
 * Each compare-and-swap is one IndexedDB transaction across tabs.
 */
export function createBrowserLogoutPurgeProgressPort(
  factory: IDBFactory = indexedDB,
): LogoutPurgeProgressPort {
  return {
    async read() {
      const database = await openBrowserControlDatabase(factory);
      try {
        const transaction = database.transaction(
          LOGOUT_PURGE_CONTROL_STORE,
          'readonly',
        );
        const marker = await browserControlRequestValue(
          transaction
            .objectStore(LOGOUT_PURGE_CONTROL_STORE)
            .get(CURRENT_CONTROL_MARKER_KEY),
        );
        await browserControlTransactionCompletion(transaction);
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
  const database = await openBrowserControlDatabase(factory);
  try {
    const transaction = database.transaction(
      LOGOUT_PURGE_CONTROL_STORE,
      'readwrite',
    );
    const store = transaction.objectStore(LOGOUT_PURGE_CONTROL_STORE);
    const marker = await browserControlRequestValue(
      store.get(CURRENT_CONTROL_MARKER_KEY),
    );
    if (!canWrite(marker, input)) {
      await abortBrowserControlTransaction(transaction);
      return false;
    }
    store.put(input.progress, CURRENT_CONTROL_MARKER_KEY);
    await browserControlTransactionCompletion(transaction);
    return true;
  } finally {
    database.close();
  }
}

async function clearMarker(
  factory: IDBFactory,
  input: LogoutPurgeProgressClear,
): Promise<unknown> {
  const database = await openBrowserControlDatabase(factory);
  try {
    const transaction = database.transaction(
      LOGOUT_PURGE_CONTROL_STORE,
      'readwrite',
    );
    const store = transaction.objectStore(LOGOUT_PURGE_CONTROL_STORE);
    const marker = await browserControlRequestValue(
      store.get(CURRENT_CONTROL_MARKER_KEY),
    );
    if (!canClear(marker, input)) {
      await abortBrowserControlTransaction(transaction);
      return false;
    }
    store.delete(CURRENT_CONTROL_MARKER_KEY);
    await browserControlTransactionCompletion(transaction);
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
