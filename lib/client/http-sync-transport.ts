import type {
  LegacyNotesScope,
  SyncTransport,
} from '@/lib/application/notes-runtime';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import type { SyncV2Transport } from '@/lib/application/sync-v2-client';

export type SyncFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export function createV1SyncTransport(
  scope: LegacyNotesScope,
  fetchRequest?: SyncFetch,
): SyncTransport<LegacyNotesScope> {
  return {
    scope,
    async send(request) {
      const response = await (fetchRequest ?? fetch)(scope.syncEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error(`sync returned ${response.status}`);
      const input: unknown = await response.json();
      return input;
    },
  };
}

export function createV2SyncTransport<TScope extends VaultNotesScope>(
  scope: TScope,
  fetchRequest?: SyncFetch,
): SyncV2Transport<TScope> {
  return {
    scope,
    async send(request) {
      const response = await (fetchRequest ?? fetch)('/api/v2/sync', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(request),
      });
      if (!response.ok) throw new Error(`sync v2 returned ${response.status}`);
      const input: unknown = await response.json();
      return input;
    },
  };
}
