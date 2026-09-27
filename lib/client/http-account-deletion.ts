'use client';

import {
  accountDeletionWireStatusDecoder,
  type AccountDeletionRemotePort,
  type AccountDeletionRemoteResult,
} from '@/lib/application/account-deletion-handoff';
import type { SyncFetch } from '@/lib/client/http-sync-transport';
import { literalDecoder, objectDecoder } from '@/lib/codec/core';

export function createAccountDeletionHttpRemote(
  fetchRequest: SyncFetch = fetch,
  endpoints: {
    readonly start: string;
    readonly resume: string;
  } = {
    start: '/api/account/deletion',
    resume: '/api/account/deletion/status',
  },
): AccountDeletionRemotePort {
  return {
    start: ({ idempotencyKey }) =>
      send(
        fetchRequest,
        endpoints.start,
        { idempotencyKey },
        'authentication-required',
      ),
    resume: ({ continuationToken }) =>
      send(
        fetchRequest,
        endpoints.resume,
        { continuationToken },
        'continuation-required',
      ),
  };
}

async function send(
  fetchRequest: SyncFetch,
  endpoint: string,
  body: Record<string, string>,
  unauthorizedReason: 'authentication-required' | 'continuation-required',
): Promise<AccountDeletionRemoteResult> {
  let response: Response;
  try {
    response = await fetchRequest(endpoint, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    return rejected('remote-unavailable');
  }
  if (!response.ok) {
    if (response.status === 401) {
      let input: unknown;
      try {
        input = await response.json();
      } catch {
        return rejected('remote-unavailable');
      }
      const decoded = objectDecoder({
        error: literalDecoder(unauthorizedReason),
      }).decode(input);
      return decoded.ok
        ? rejected(unauthorizedReason)
        : rejected('remote-unavailable');
    }
    if (response.status === 409) return rejected('request-conflict');
    return rejected('remote-unavailable');
  }
  let input: unknown;
  try {
    input = await response.json();
  } catch {
    return rejected('remote-unavailable');
  }
  const decoded = accountDeletionWireStatusDecoder.decode(input);
  return decoded.ok
    ? { kind: 'accepted', status: decoded.value }
    : rejected('remote-unavailable');
}

function rejected(
  reason: Extract<
    AccountDeletionRemoteResult,
    { readonly kind: 'rejected' }
  >['reason'],
): AccountDeletionRemoteResult {
  return { kind: 'rejected', reason };
}
