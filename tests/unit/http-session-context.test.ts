import { describe, expect, it } from 'vitest';
import {
  loadSessionContext,
  type SessionContextFetch,
} from '@/lib/client/http-session-context';
import { sessionFixtureIds } from '@/tests/fixtures/session';

describe('HTTP session-context boundary', () => {
  it('loads an exact authenticated Vault context without exposing a token', async () => {
    let captured:
      | {
          readonly input: RequestInfo | URL;
          readonly init: RequestInit | undefined;
        }
      | undefined;
    const fetchRequest: SessionContextFetch = async (input, init) => {
      captured = { input, init };
      return Response.json({
        accountId: sessionFixtureIds.accountId,
        vaultId: sessionFixtureIds.vaultId,
        sessionId: sessionFixtureIds.sessionId,
        sessionEpoch: sessionFixtureIds.epoch,
      });
    };

    await expect(loadSessionContext(fetchRequest)).resolves.toEqual({
      kind: 'authenticated',
      context: {
        accountId: sessionFixtureIds.accountId,
        vaultId: sessionFixtureIds.vaultId,
        sessionId: sessionFixtureIds.sessionId,
        sessionEpoch: sessionFixtureIds.epoch,
      },
    });
    expect(captured).toEqual({
      input: '/api/session-context',
      init: {
        method: 'GET',
        credentials: 'same-origin',
        cache: 'no-store',
      },
    });
  });

  it('maps only 401 to anonymous and fails closed for malformed or unavailable data', async () => {
    await expect(
      loadSessionContext(async () => new Response(null, { status: 401 })),
    ).resolves.toEqual({ kind: 'anonymous' });
    await expect(
      loadSessionContext(async () =>
        Response.json(
          {
            accountId: sessionFixtureIds.accountId,
            vaultId: sessionFixtureIds.vaultId,
            sessionId: sessionFixtureIds.sessionId,
            sessionEpoch: sessionFixtureIds.epoch,
            token: 'must-not-be-accepted',
          },
          { status: 200 },
        ),
      ),
    ).resolves.toEqual({ kind: 'unavailable' });
    await expect(
      loadSessionContext(async () => new Response(null, { status: 503 })),
    ).resolves.toEqual({ kind: 'unavailable' });
    await expect(
      loadSessionContext(async () => {
        throw new Error('network detail');
      }),
    ).resolves.toEqual({ kind: 'unavailable' });
  });
});
