import { describe, expect, it, vi } from 'vitest';
import {
  createAccountDeletionResumeHandler,
  createAccountDeletionStartHandler,
  type AccountDeletionHttpDependencies,
} from '@/app/api/account/deletion/handler';
import {
  parseAccountDeletionContinuationToken,
  parseAccountDeletionIdempotencyKey,
  type AccountDeletionApplication,
} from '@/server/account-deletion/public';
import { SESSION_COOKIE_NAME } from '@/server/core/session-cookie';
import { cookieHeader, fixtureActiveSession } from '@/tests/fixtures/session';

const expectedOrigin = 'https://notes.example';
const idempotencyKey = parseAccountDeletionIdempotencyKey('I'.repeat(43));
const token0 = parseAccountDeletionContinuationToken(
  `${'ad1.'}${'S'.repeat(43)}.0`,
);
const token1 = parseAccountDeletionContinuationToken(
  `${'ad1.'}${'S'.repeat(43)}.1`,
);

describe('account deletion HTTP handlers', () => {
  it('derives owner scope from the authenticated session and starts before revocation', async () => {
    const start = vi.fn(async () => ({
      kind: 'accepted' as const,
      status: { kind: 'in-progress' as const },
      continuationToken: token0,
    }));
    const response = await createAccountDeletionStartHandler(
      dependencies({ application: application({ start }) }),
    )(
      request('/api/account/deletion', {
        body: JSON.stringify({ idempotencyKey }),
        cookie: cookieHeader(),
      }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('set-cookie')).toBeNull();
    await expect(response.json()).resolves.toEqual({
      status: 'in-progress',
      continuationToken: token0,
    });
    expect(start).toHaveBeenCalledWith({
      scope: {
        accountId: fixtureActiveSession().accountId,
        vaultId: fixtureActiveSession().vaultId,
      },
      idempotencyKey,
      requestedAt: 1_500,
    });
  });

  it('rejects anonymous, cross-site, malformed, and body-injected owner requests before start', async () => {
    const start = vi.fn(async () => ({
      kind: 'accepted' as const,
      status: { kind: 'in-progress' as const },
      continuationToken: token0,
    }));
    const handler = createAccountDeletionStartHandler(
      dependencies({ application: application({ start }) }),
    );
    expect(
      (await handler(request('/api/account/deletion', { body: '{}' }))).status,
    ).toBe(401);
    expect(
      (
        await handler(
          request('/api/account/deletion', {
            body: JSON.stringify({ idempotencyKey }),
            cookie: cookieHeader(),
            origin: 'https://attacker.example',
            site: 'cross-site',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request('/api/account/deletion', {
            body: JSON.stringify({
              idempotencyKey,
              accountId: fixtureActiveSession().accountId,
            }),
            cookie: cookieHeader(),
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          request('/api/account/deletion', {
            body: JSON.stringify({ idempotencyKey }),
            cookie: cookieHeader(),
            contentLength: '2049',
          }),
        )
      ).status,
    ).toBe(413);
    expect(start).not.toHaveBeenCalled();
  });

  it('resumes with no session, rotates the sequence response, and clears any old cookie', async () => {
    const resume = vi.fn(async () => ({
      kind: 'accepted' as const,
      status: { kind: 'retry-wait' as const, retryAt: 2_000 },
      continuationToken: token1,
    }));
    const response = await createAccountDeletionResumeHandler({
      application: application({ resume }),
      clock: { now: () => 1_500 },
      expectedOrigin,
    })(
      request('/api/account/deletion/status', {
        body: JSON.stringify({ continuationToken: token0 }),
      }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('set-cookie')).toContain(
      `${SESSION_COOKIE_NAME}=`,
    );
    expect(response.headers.get('set-cookie')).toContain('Max-Age=0');
    await expect(response.json()).resolves.toEqual({
      status: 'retry-wait',
      retryAt: 2_000,
      continuationToken: token1,
    });
    expect(resume).toHaveBeenCalledWith({ token: token0, resumedAt: 1_500 });
  });

  it('returns the same generic denial for malformed and unknown capabilities', async () => {
    const resume = vi.fn(async () => ({
      kind: 'rejected' as const,
      reason: 'invalid-capability' as const,
    }));
    const handler = createAccountDeletionResumeHandler({
      application: application({ resume }),
      clock: { now: () => 1_500 },
      expectedOrigin,
    });
    const malformed = await handler(
      request('/api/account/deletion/status', {
        body: JSON.stringify({ continuationToken: 'invalid' }),
      }),
    );
    const unknown = await handler(
      request('/api/account/deletion/status', {
        body: JSON.stringify({ continuationToken: token0 }),
      }),
    );
    expect(malformed.status).toBe(401);
    expect(unknown.status).toBe(401);
    await expect(malformed.json()).resolves.toEqual({
      error: 'continuation-required',
    });
    const unknownPayload: unknown = await unknown.json();
    expect(unknownPayload).toEqual({
      error: 'continuation-required',
    });
    expect(JSON.stringify(unknownPayload)).not.toMatch(
      /account|vault|operation|provider/,
    );
  });

  it('reports terminal state without returning a reusable capability', async () => {
    const response = await createAccountDeletionResumeHandler({
      application: application({
        resume: async () => ({
          kind: 'accepted',
          status: { kind: 'completed' },
        }),
      }),
      clock: { now: () => 1_500 },
      expectedOrigin,
    })(
      request('/api/account/deletion/status', {
        body: JSON.stringify({ continuationToken: token0 }),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'completed' });
  });
});

function dependencies(
  overrides: Partial<AccountDeletionHttpDependencies> = {},
): AccountDeletionHttpDependencies {
  return {
    expectedOrigin,
    clock: { now: () => 1_500 },
    sessions: { findSessionByToken: async () => fixtureActiveSession() },
    application: application(),
    ...overrides,
  };
}

function application(
  overrides: Partial<AccountDeletionApplication> = {},
): AccountDeletionApplication {
  return {
    start: async () => ({
      kind: 'accepted',
      status: { kind: 'in-progress' },
      continuationToken: token0,
    }),
    resume: async () => ({
      kind: 'accepted',
      status: { kind: 'in-progress' },
      continuationToken: token1,
    }),
    ...overrides,
  };
}

function request(
  pathname: string,
  input: {
    readonly body: string;
    readonly cookie?: string;
    readonly origin?: string;
    readonly site?: string;
    readonly contentLength?: string;
  },
): Request {
  const headers = new Headers({
    'content-type': 'application/json',
    origin: input.origin ?? expectedOrigin,
    'sec-fetch-site': input.site ?? 'same-origin',
  });
  if (input.cookie !== undefined) headers.set('cookie', input.cookie);
  if (input.contentLength !== undefined) {
    headers.set('content-length', input.contentLength);
  }
  return new Request(`${expectedOrigin}${pathname}`, {
    method: 'POST',
    headers,
    body: input.body,
  });
}
