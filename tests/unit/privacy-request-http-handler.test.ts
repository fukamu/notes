import { describe, expect, it, vi } from 'vitest';
import {
  createPrivacyRequestStatusHandler,
  createPrivacyRequestSubmitHandler,
  type PrivacyRequestHttpDependencies,
} from '@/app/api/account/privacy-requests/handler';
import { privacyRequestPublicStatus } from '@/server/privacy-request/application-core';
import type { PrivacyRequestApplication } from '@/server/privacy-request/application';
import {
  containsSensitiveMarker,
  securityCorpusMarker,
} from '@/tests/fixtures/security-corpus';
import {
  privacyRequestIds,
  privacyRequestRecord,
} from '@/tests/fixtures/privacy-request';
import { cookieHeader, fixtureActiveSession } from '@/tests/fixtures/session';

const expectedOrigin = 'https://notes.example';

describe('privacy request HTTP handlers', () => {
  it('derives scope from session and returns only public request status', async () => {
    const submit = vi.fn(async () => ({
      kind: 'accepted' as const,
      outcome: 'recorded' as const,
      request: privacyRequestPublicStatus(privacyRequestRecord()),
    }));
    const response = await createPrivacyRequestSubmitHandler(
      dependencies({ application: application({ submit }) }),
    )(
      request('/api/account/privacy-requests', {
        body: JSON.stringify({
          submissionId: privacyRequestIds.submissionA,
          requestKind: 'disclosure',
        }),
        cookie: cookieHeader(),
      }),
    );
    expect(response.status).toBe(202);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const payload: unknown = await response.json();
    expect(payload).toEqual({
      requestId: privacyRequestIds.requestA,
      requestKind: 'disclosure',
      status: 'verification-pending',
      requestedAt: 1_000,
      updatedAt: 1_000,
    });
    expect(JSON.stringify(payload)).not.toMatch(/accountId|vaultId|receipt/);
    expect(submit).toHaveBeenCalledWith({
      scope: {
        accountId: fixtureActiveSession().accountId,
        vaultId: fixtureActiveSession().vaultId,
      },
      command: {
        submissionId: privacyRequestIds.submissionA,
        requestKind: 'disclosure',
      },
      requestId: privacyRequestIds.requestA,
      requestedAt: 1_500,
    });
  });

  it('tracks status through the same authenticated session boundary', async () => {
    const status = vi.fn(async () => ({
      kind: 'accepted' as const,
      outcome: 'status' as const,
      request: privacyRequestPublicStatus(privacyRequestRecord()),
    }));
    const response = await createPrivacyRequestStatusHandler(
      dependencies({ application: application({ status }) }),
    )(
      request('/api/account/privacy-requests/status', {
        body: JSON.stringify({ requestId: privacyRequestIds.requestA }),
        cookie: cookieHeader(),
      }),
    );
    expect(response.status).toBe(202);
    expect(status).toHaveBeenCalledWith({
      scope: {
        accountId: fixtureActiveSession().accountId,
        vaultId: fixtureActiveSession().vaultId,
      },
      requestId: privacyRequestIds.requestA,
    });
  });

  it('rejects anonymous, cross-site, owner-injected, malformed, and oversized input before application code', async () => {
    const submit = vi.fn();
    const handler = createPrivacyRequestSubmitHandler(
      dependencies({ application: application({ submit }) }),
    );
    expect(
      (
        await handler(
          request('/api/account/privacy-requests', {
            body: JSON.stringify({
              submissionId: privacyRequestIds.submissionA,
              requestKind: 'disclosure',
            }),
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handler(
          request('/api/account/privacy-requests', {
            body: JSON.stringify({
              submissionId: privacyRequestIds.submissionA,
              requestKind: 'disclosure',
            }),
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
          request('/api/account/privacy-requests', {
            body: JSON.stringify({
              submissionId: privacyRequestIds.submissionA,
              requestKind: 'disclosure',
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
          request('/api/account/privacy-requests', {
            body: '{',
            cookie: cookieHeader(),
          }),
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await handler(
          request('/api/account/privacy-requests', {
            body: '{}',
            cookie: cookieHeader(),
            contentLength: '2049',
          }),
        )
      ).status,
    ).toBe(413);
    expect(submit).not.toHaveBeenCalled();
  });

  it('fails closed for invalid clocks, generated IDs, and cross-tenant not-found status', async () => {
    const body = JSON.stringify({
      submissionId: privacyRequestIds.submissionA,
      requestKind: 'disclosure',
    });
    expect(
      (
        await createPrivacyRequestSubmitHandler(
          dependencies({ clock: { now: () => -1 } }),
        )(
          request('/api/account/privacy-requests', {
            body,
            cookie: cookieHeader(),
          }),
        )
      ).status,
    ).toBe(503);
    expect(
      (
        await createPrivacyRequestSubmitHandler(
          dependencies({ requestIds: { create: () => 'invalid' } }),
        )(
          request('/api/account/privacy-requests', {
            body,
            cookie: cookieHeader(),
          }),
        )
      ).status,
    ).toBe(503);

    const notFound = await createPrivacyRequestStatusHandler(
      dependencies({
        application: application({
          status: async () => ({ kind: 'rejected', reason: 'not-found' }),
        }),
      }),
    )(
      request('/api/account/privacy-requests/status', {
        body: JSON.stringify({ requestId: privacyRequestIds.requestA }),
        cookie: cookieHeader(),
      }),
    );
    expect(notFound.status).toBe(404);
    await expect(notFound.json()).resolves.toEqual({ error: 'not-found' });
  });

  it('logs only a fixed category for secret-bearing failures', async () => {
    const failure = new Error(`message:${securityCorpusMarker}`);
    failure.name = `name:${securityCorpusMarker}`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await createPrivacyRequestSubmitHandler(
      dependencies({
        application: application({
          submit: async () => {
            throw failure;
          },
        }),
      }),
    )(
      request('/api/account/privacy-requests', {
        body: JSON.stringify({
          submissionId: privacyRequestIds.submissionA,
          requestKind: 'disclosure',
        }),
        cookie: cookieHeader(),
      }),
    );
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledWith('privacy request failed', 'Error');
    expect(
      containsSensitiveMarker(log.mock.calls, [securityCorpusMarker]),
    ).toBe(false);
  });
});

function dependencies(
  overrides: Partial<PrivacyRequestHttpDependencies> = {},
): PrivacyRequestHttpDependencies {
  return {
    expectedOrigin,
    clock: { now: () => 1_500 },
    requestIds: { create: () => privacyRequestIds.requestA },
    sessions: { findSessionByToken: async () => fixtureActiveSession() },
    application: application(),
    ...overrides,
  };
}

function application(
  overrides: Partial<PrivacyRequestApplication> = {},
): PrivacyRequestApplication {
  const accepted = async () => ({
    kind: 'accepted' as const,
    outcome: 'status' as const,
    request: privacyRequestPublicStatus(privacyRequestRecord()),
  });
  return {
    submit: accepted,
    status: accepted,
    verify: accepted,
    process: accepted,
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
