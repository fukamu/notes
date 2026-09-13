import type {
  LegacyNotesScope,
  SyncTransport,
} from '@/lib/application/notes-runtime';

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
