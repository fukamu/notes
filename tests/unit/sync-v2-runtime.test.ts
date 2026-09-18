import { describe, expect, it } from 'vitest';
import { vaultNotesScope } from '@/lib/application/notes-access';
import { LEGACY_NOTES_SCOPE } from '@/lib/application/notes-runtime';
import {
  createV2SyncTransport,
  type SyncFetch,
} from '@/lib/client/http-sync-transport';
import { createLegacyNotesRuntimePorts } from '@/lib/client/legacy-notes-runtime';
import { createVaultNotesRuntimePorts } from '@/lib/client/vault-notes-runtime';
import { invariant } from '@/lib/shared/invariant';
import { encodeSyncV2Request } from '@/lib/sync/v2-protocol';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const context = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

describe('Sync v2 browser transport', () => {
  it('posts an authenticated no-store request to the versioned endpoint', async () => {
    const fixture = createCompatibilityFixture();
    const scope = vaultNotesScope(context);
    const request = encodeSyncV2Request({
      deviceId: compatibilityIds.device,
      cursor: null,
      mutations: [fixture.mutation],
    });
    const candidate = { version: 'untrusted-boundary-value' };
    let captured:
      | { input: RequestInfo | URL; init: RequestInit | undefined }
      | undefined;
    const fetchRequest: SyncFetch = async (input, init) => {
      captured = { input, init };
      return new Response(JSON.stringify(candidate), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const result = await createV2SyncTransport(scope, fetchRequest).send(
      request,
    );

    invariant(captured, 'Sync v2 transport did not call fetch');
    expect(captured.input).toBe('/api/v2/sync');
    expect(captured.init).toEqual({
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
    });
    expect(result).toEqual(candidate);
  });

  it('rejects non-success responses before the page decoder sees a body', async () => {
    const fixture = createCompatibilityFixture();
    const scope = vaultNotesScope(context);
    const fetchRequest: SyncFetch = async () =>
      new Response(null, { status: 401 });
    const request = encodeSyncV2Request({
      deviceId: compatibilityIds.device,
      cursor: null,
      mutations: [fixture.mutation],
    });

    await expect(
      createV2SyncTransport(scope, fetchRequest).send(request),
    ).rejects.toThrow('sync v2 returned 401');
  });
});

describe('notes runtime composition', () => {
  it('keeps local legacy use on v1 and authenticated Vault use on v2', () => {
    const legacy = createLegacyNotesRuntimePorts();
    const vault = createVaultNotesRuntimePorts(context);

    expect(legacy.scope).toEqual(LEGACY_NOTES_SCOPE);
    expect(legacy.sync.kind).toBe('v1');
    expect(vault.scope).toEqual(vaultNotesScope(context));
    expect(vault.repository.scope).toEqual(vault.scope);
    expect(vault.sync.kind).toBe('v2');
    expect(vault.sync.client.scope).toEqual(vault.scope);
  });
});
