import { describe, expect, it, vi } from 'vitest';
import { evaluateCsrfRequest } from '@/server/core/csrf';
import { revokeSession } from '@/server/core/session';
import { createFakeSessionResolver } from '@/server/adapters/fake-session-resolver';
import { sessionMetadataFromRequest } from '@/server/adapters/web-session';
import {
  deriveVaultContext,
  sessionTokenFromCookieHeader,
  type SessionCredentialResolver,
} from '@/server/session-boundary';
import {
  cookieHeader,
  fixtureActiveSession,
  sessionFixtureIds,
} from '@/tests/fixtures/session';

describe('CSRF origin policy', () => {
  it('allows safe methods and exact same-origin browser mutations', () => {
    expect(
      evaluateCsrfRequest({
        method: 'GET',
        expectedOrigin: null,
        originHeader: null,
        secFetchSiteHeader: null,
      }),
    ).toEqual({ kind: 'allowed', reason: 'safe-method' });
    expect(
      evaluateCsrfRequest({
        method: 'POST',
        expectedOrigin: 'https://notes.example',
        originHeader: 'https://notes.example',
        secFetchSiteHeader: 'same-origin',
      }),
    ).toEqual({ kind: 'allowed', reason: 'same-origin' });
  });

  it('fails closed for missing, malformed, same-site, and cross-site metadata', () => {
    const base = {
      method: 'POST',
      expectedOrigin: 'https://notes.example',
      originHeader: 'https://notes.example',
      secFetchSiteHeader: 'same-origin',
    } as const;
    expect(evaluateCsrfRequest({ ...base, method: 'post' })).toEqual({
      kind: 'denied',
      reason: 'invalid-method',
    });
    expect(
      evaluateCsrfRequest({
        ...base,
        expectedOrigin: 'https://notes.example/',
      }),
    ).toEqual({ kind: 'denied', reason: 'invalid-expected-origin' });
    expect(evaluateCsrfRequest({ ...base, originHeader: null })).toEqual({
      kind: 'denied',
      reason: 'missing-origin',
    });
    expect(
      evaluateCsrfRequest({ ...base, originHeader: 'https://evil.example' }),
    ).toEqual({ kind: 'denied', reason: 'origin-mismatch' });
    expect(evaluateCsrfRequest({ ...base, secFetchSiteHeader: null })).toEqual({
      kind: 'denied',
      reason: 'missing-fetch-metadata',
    });
    for (const value of ['cross-site', 'same-site', 'none']) {
      expect(
        evaluateCsrfRequest({ ...base, secFetchSiteHeader: value }),
      ).toEqual({ kind: 'denied', reason: 'cross-site' });
    }
  });
});

describe('server session boundary', () => {
  it('derives tenant context only from the resolved session, never the body', async () => {
    const active = fixtureActiveSession();
    const resolver = createFakeSessionResolver([
      { token: sessionFixtureIds.token, record: active },
    ]);
    const request = new Request('https://notes.example/api/v2/sync', {
      method: 'POST',
      headers: {
        cookie: cookieHeader(),
        origin: 'https://notes.example',
        'sec-fetch-site': 'same-origin',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        accountId: sessionFixtureIds.otherAccountId,
        vaultId: sessionFixtureIds.otherVaultId,
      }),
    });

    await expect(
      deriveVaultContext(
        sessionMetadataFromRequest(request, {
          expectedOrigin: 'https://notes.example',
          now: 1_500,
        }),
        resolver,
      ),
    ).resolves.toEqual({
      kind: 'authenticated',
      context: {
        accountId: sessionFixtureIds.accountId,
        vaultId: sessionFixtureIds.vaultId,
        sessionId: sessionFixtureIds.sessionId,
        sessionEpoch: sessionFixtureIds.epoch,
      },
    });
  });

  it('rejects cross-site requests before session lookup', async () => {
    const lookup = vi.fn(async () => fixtureActiveSession());
    const resolver: SessionCredentialResolver = {
      findSessionByToken: lookup,
    };
    const result = await deriveVaultContext(
      {
        method: 'DELETE',
        cookieHeader: cookieHeader(),
        originHeader: 'https://evil.example',
        secFetchSiteHeader: 'cross-site',
        expectedOrigin: 'https://notes.example',
        now: 1_500,
      },
      resolver,
    );
    expect(result).toEqual({
      kind: 'forbidden',
      csrf: { kind: 'denied', reason: 'origin-mismatch' },
    });
    expect(lookup).not.toHaveBeenCalled();
  });

  it('fails closed for absent, duplicate, unknown, malformed, and revoked sessions', async () => {
    const active = fixtureActiveSession();
    const revoked = revokeSession(active, 1_400, 'security');
    expect(revoked.kind).toBe('revoked');
    if (revoked.kind !== 'revoked') return;
    const base = {
      method: 'GET',
      originHeader: null,
      secFetchSiteHeader: null,
      expectedOrigin: 'https://notes.example',
      now: 1_500,
    } as const;

    await expect(
      deriveVaultContext(
        { ...base, cookieHeader: null },
        createFakeSessionResolver([]),
      ),
    ).resolves.toEqual({ kind: 'anonymous', reason: 'missing-session' });
    await expect(
      deriveVaultContext(
        {
          ...base,
          cookieHeader: `${cookieHeader()}; ${cookieHeader()}`,
        },
        createFakeSessionResolver([]),
      ),
    ).resolves.toEqual({ kind: 'anonymous', reason: 'invalid-cookie' });
    await expect(
      deriveVaultContext(
        { ...base, cookieHeader: cookieHeader(sessionFixtureIds.otherToken) },
        createFakeSessionResolver([]),
      ),
    ).resolves.toEqual({ kind: 'anonymous', reason: 'unknown-session' });
    await expect(
      deriveVaultContext(
        { ...base, cookieHeader: cookieHeader() },
        createFakeSessionResolver([
          { token: sessionFixtureIds.token, record: { kind: 'active' } },
        ]),
      ),
    ).resolves.toEqual({
      kind: 'anonymous',
      reason: 'invalid-session-record',
    });
    await expect(
      deriveVaultContext(
        { ...base, cookieHeader: cookieHeader() },
        createFakeSessionResolver([
          { token: sessionFixtureIds.token, record: revoked.session },
        ]),
      ),
    ).resolves.toEqual({ kind: 'anonymous', reason: 'revoked' });
    await expect(
      deriveVaultContext(
        { ...base, cookieHeader: cookieHeader(), now: active.expiresAt },
        createFakeSessionResolver([
          { token: sessionFixtureIds.token, record: active },
        ]),
      ),
    ).resolves.toEqual({ kind: 'anonymous', reason: 'expired' });
  });

  it('decodes only one exact host-session cookie', () => {
    expect(sessionTokenFromCookieHeader(cookieHeader())).toEqual({
      kind: 'found',
      token: sessionFixtureIds.token,
    });
    expect(
      sessionTokenFromCookieHeader(`other=value; ${cookieHeader()}`),
    ).toEqual({ kind: 'found', token: sessionFixtureIds.token });
    expect(sessionTokenFromCookieHeader('__Host-fukamu_session=short')).toEqual(
      { kind: 'invalid' },
    );
    expect(
      sessionTokenFromCookieHeader(`${cookieHeader()}; ${cookieHeader()}`),
    ).toEqual({ kind: 'invalid' });
  });
});
