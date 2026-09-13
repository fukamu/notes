import { describe, expect, it, vi } from 'vitest';
import { handleSyncRequest } from '@/app/api/sync/handler';
import { decodeOrThrow } from '@/lib/codec/core';
import {
  createControlPlaneSessionResolver,
  webCryptoSessionTokenHashes,
} from '@/server/control-plane/session-resolver';
import { sessionTokenHashDecoder } from '@/server/control-plane/records';
import {
  legacySyncIsEnabled,
  resolveServiceRuntimeMode,
} from '@/server/runtime-mode';
import {
  fixtureActiveSession,
  sessionFixtureIds,
} from '@/tests/fixtures/session';

describe('Sync v2 composition boundaries', () => {
  it('hashes the high-entropy cookie token before control-plane lookup', async () => {
    const hash = decodeOrThrow(
      sessionTokenHashDecoder,
      await webCryptoSessionTokenHashes.digest(sessionFixtureIds.token),
      'test session hash',
    );
    const lookup = vi.fn(async () => ({
      session: fixtureActiveSession(),
      tokenHash: hash,
    }));
    const resolver = createControlPlaneSessionResolver({
      controlPlane: { findSessionByTokenHash: lookup },
      hashes: webCryptoSessionTokenHashes,
    });
    await expect(
      resolver.findSessionByToken(sessionFixtureIds.token),
    ).resolves.toEqual(fixtureActiveSession());
    expect(lookup).toHaveBeenCalledWith(hash);
    expect(hash).not.toBe(sessionFixtureIds.token);
  });

  it('keeps local/Sites legacy mode convenient and public-paid mode explicit', () => {
    expect(resolveServiceRuntimeMode({})).toEqual({
      kind: 'configured',
      mode: 'legacy-test',
    });
    expect(legacySyncIsEnabled({ FUKAMU_SERVICE_MODE: 'legacy-test' })).toBe(
      true,
    );
    expect(legacySyncIsEnabled({ FUKAMU_SERVICE_MODE: 'public-paid' })).toBe(
      false,
    );
    expect(legacySyncIsEnabled({ FUKAMU_SERVICE_MODE: 'typo' })).toBe(false);
  });

  it('disables unauthenticated v1 before touching D1 in public-paid mode', async () => {
    const response = await handleSyncRequest(
      new Request('https://notes.example/api/sync', {
        method: 'POST',
        body: '{}',
      }),
      { FUKAMU_SERVICE_MODE: 'public-paid' },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});
