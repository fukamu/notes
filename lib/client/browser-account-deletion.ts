'use client';

import type { AccountDeletionHandoffRunner } from '@/lib/application/account-deletion-handoff';
import { createAccountDeletionHandoffRunner } from '@/lib/application/account-deletion-runner';
import { createBrowserAccountDeletionProgressPort } from '@/lib/client/browser-account-deletion-progress';
import type { BrowserLogoutPurgeService } from '@/lib/client/browser-logout-purge';
import { createAccountDeletionHttpRemote } from '@/lib/client/http-account-deletion';
import type { SyncFetch } from '@/lib/client/http-sync-transport';

export type AccountDeletionRandomValues = (bytes: Uint8Array) => unknown;

export function createBrowserAccountDeletionRunner(
  logout: BrowserLogoutPurgeService,
  options: {
    readonly fetchRequest?: SyncFetch;
    readonly randomValues?: AccountDeletionRandomValues;
    readonly clock?: { readonly now: () => unknown };
    readonly indexedDb?: IDBFactory;
  } = {},
): AccountDeletionHandoffRunner {
  const progress = createBrowserAccountDeletionProgressPort(options.indexedDb);
  return createAccountDeletionHandoffRunner({
    progress,
    remote: createAccountDeletionHttpRemote(options.fetchRequest),
    idempotencyKeys: createBrowserIdempotencyKeyGenerator(options.randomValues),
    logoutPurge: logout.purge,
    clock: options.clock ?? { now: () => Date.now() },
  });
}

export function createBrowserIdempotencyKeyGenerator(
  randomValues: AccountDeletionRandomValues = (bytes) =>
    crypto.getRandomValues(bytes),
) {
  return {
    create(): unknown {
      const bytes = new Uint8Array(32);
      randomValues(bytes);
      return base64UrlEncode(bytes);
    },
  };
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
