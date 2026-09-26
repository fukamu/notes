import { objectDecoder } from '@/lib/codec/core';
import {
  accountIdDecoder,
  sessionEpochDecoder,
  sessionIdDecoder,
  vaultIdDecoder,
  type VaultContext,
} from '@/lib/domain/identity';

export type SessionContextLoadResult =
  | { readonly kind: 'authenticated'; readonly context: VaultContext }
  | { readonly kind: 'anonymous' }
  | { readonly kind: 'unavailable' };

export type SessionContextFetch = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

const sessionContextDecoder = objectDecoder({
  accountId: accountIdDecoder,
  vaultId: vaultIdDecoder,
  sessionId: sessionIdDecoder,
  sessionEpoch: sessionEpochDecoder,
});

export async function loadSessionContext(
  fetchRequest: SessionContextFetch = fetch,
  signal?: AbortSignal,
): Promise<SessionContextLoadResult> {
  try {
    const init: RequestInit = {
      method: 'GET',
      credentials: 'same-origin',
      cache: 'no-store',
    };
    if (signal !== undefined) init.signal = signal;
    const response = await fetchRequest('/api/session-context', init);
    if (response.status === 401) return { kind: 'anonymous' };
    if (!response.ok) return { kind: 'unavailable' };
    const input: unknown = await response.json();
    const decoded = sessionContextDecoder.decode(input);
    return decoded.ok
      ? { kind: 'authenticated', context: decoded.value }
      : { kind: 'unavailable' };
  } catch {
    return { kind: 'unavailable' };
  }
}
