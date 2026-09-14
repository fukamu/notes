'use client';

import {
  inspectAccountDeletionHandoff,
  sameAccountDeletionGeneration,
  type AccountDeletionHandoffClear,
  type AccountDeletionHandoffProgressPort,
  type AccountDeletionHandoffWrite,
} from '@/lib/application/account-deletion-handoff';
import {
  ACCOUNT_DELETION_CONTROL_STORE,
  CURRENT_CONTROL_MARKER_KEY,
  abortBrowserControlTransaction,
  browserControlRequestValue,
  browserControlTransactionCompletion,
  openBrowserControlDatabase,
} from '@/lib/client/browser-control-database';

/** Stores only the deletion capability handoff; it never contains note data. */
export function createBrowserAccountDeletionProgressPort(
  factory: IDBFactory = indexedDB,
): AccountDeletionHandoffProgressPort {
  return {
    async read() {
      const database = await openBrowserControlDatabase(factory);
      try {
        const transaction = database.transaction(
          ACCOUNT_DELETION_CONTROL_STORE,
          'readonly',
        );
        const marker = await browserControlRequestValue(
          transaction
            .objectStore(ACCOUNT_DELETION_CONTROL_STORE)
            .get(CURRENT_CONTROL_MARKER_KEY),
        );
        await browserControlTransactionCompletion(transaction);
        return marker;
      } finally {
        database.close();
      }
    },
    write: (write) => writeMarker(factory, write),
    clear: (clear) => clearMarker(factory, clear),
  };
}

async function writeMarker(
  factory: IDBFactory,
  write: AccountDeletionHandoffWrite,
): Promise<unknown> {
  const database = await openBrowserControlDatabase(factory);
  try {
    const transaction = database.transaction(
      ACCOUNT_DELETION_CONTROL_STORE,
      'readwrite',
    );
    const store = transaction.objectStore(ACCOUNT_DELETION_CONTROL_STORE);
    const marker = await browserControlRequestValue(
      store.get(CURRENT_CONTROL_MARKER_KEY),
    );
    if (!canWrite(marker, write)) {
      await abortBrowserControlTransaction(transaction);
      return false;
    }
    store.put(write.handoff, CURRENT_CONTROL_MARKER_KEY);
    await browserControlTransactionCompletion(transaction);
    return true;
  } finally {
    database.close();
  }
}

async function clearMarker(
  factory: IDBFactory,
  clear: AccountDeletionHandoffClear,
): Promise<unknown> {
  const database = await openBrowserControlDatabase(factory);
  try {
    const transaction = database.transaction(
      ACCOUNT_DELETION_CONTROL_STORE,
      'readwrite',
    );
    const store = transaction.objectStore(ACCOUNT_DELETION_CONTROL_STORE);
    const marker = await browserControlRequestValue(
      store.get(CURRENT_CONTROL_MARKER_KEY),
    );
    if (!canClear(marker, clear)) {
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

function canWrite(
  marker: unknown,
  write: AccountDeletionHandoffWrite,
): boolean {
  switch (write.kind) {
    case 'create':
      return marker === undefined;
    case 'replace': {
      const current = inspectAccountDeletionHandoff(marker);
      return (
        current.kind === 'loaded' &&
        current.handoff.revision === write.expectedRevision &&
        sameAccountDeletionGeneration(current.handoff, write.handoff)
      );
    }
  }
}

function canClear(
  marker: unknown,
  clear: AccountDeletionHandoffClear,
): boolean {
  const current = inspectAccountDeletionHandoff(marker);
  return (
    current.kind === 'loaded' &&
    current.handoff.revision === clear.expectedRevision &&
    sameAccountDeletionGeneration(current.handoff, clear.generation)
  );
}
