'use client';

export const BROWSER_CONTROL_DATABASE_NAME = 'fukamu-notes:control:v1' as const;
export const BROWSER_CONTROL_DATABASE_VERSION = 2;
export const LOGOUT_PURGE_CONTROL_STORE = 'logout-purge' as const;
export const ACCOUNT_DELETION_CONTROL_STORE =
  'account-deletion-handoff' as const;
export const CURRENT_CONTROL_MARKER_KEY = 'current' as const;

const stores = [
  LOGOUT_PURGE_CONTROL_STORE,
  ACCOUNT_DELETION_CONTROL_STORE,
] as const;

/** Opens the non-content device-control database and only adds known stores. */
export function openBrowserControlDatabase(
  factory: IDBFactory,
): Promise<IDBDatabase> {
  let request: IDBOpenDBRequest;
  try {
    request = factory.open(
      BROWSER_CONTROL_DATABASE_NAME,
      BROWSER_CONTROL_DATABASE_VERSION,
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
      for (const store of stores) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
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

export function browserControlRequestValue(
  request: IDBRequest,
): Promise<unknown> {
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

export function browserControlTransactionCompletion(
  transaction: IDBTransaction,
): Promise<void> {
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

export async function abortBrowserControlTransaction(
  transaction: IDBTransaction,
): Promise<void> {
  transaction.abort();
  try {
    await browserControlTransactionCompletion(transaction);
  } catch {
    // An intentional CAS mismatch abort leaves the marker unchanged.
  }
}
