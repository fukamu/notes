import { describe, expect, it, vi } from 'vitest';
import {
  createTermsConsentAcceptHandler,
  createTermsConsentStatusHandler,
  type TermsConsentHttpDependencies,
} from '@/app/api/account/terms-consent/handler';
import type {
  TermsConsentApplication,
  TermsConsentApplicationResult,
} from '@/server/terms-consent/application';
import { cookieHeader, fixtureActiveSession } from '@/tests/fixtures/session';
import {
  containsSensitiveMarker,
  securityCorpusMarker,
} from '@/tests/fixtures/security-corpus';
import {
  termsConsentCommand,
  termsConsentIds,
  termsConsentRecord,
  termsSnapshot,
} from '@/tests/fixtures/terms-consent';

const expectedOrigin = 'https://notes.example';

describe('terms consent HTTP handlers', () => {
  it('returns only public status from the authenticated session scope', async () => {
    const status = vi.fn(async () => currentStatus());
    const response = await createTermsConsentStatusHandler(
      dependencies({ application: application({ status }) }),
    )(request('GET'));
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const payload: unknown = await response.json();
    expect(payload).toEqual({
      outcome: 'status',
      status: {
        kind: 'current',
        acceptanceRequired: true,
        current: {
          termsVersion: termsSnapshot().termsVersion,
          termsHash: termsSnapshot().termsHash,
          effectiveDate: termsSnapshot().disclosure.effectiveDate,
        },
      },
    });
    expect(JSON.stringify(payload)).not.toMatch(
      /accountId|vaultId|serializedTerms|legalReviewId/,
    );
    expect(status).toHaveBeenCalledWith({
      context: {
        accountId: fixtureActiveSession().accountId,
        vaultId: fixtureActiveSession().vaultId,
        sessionId: fixtureActiveSession().sessionId,
        sessionEpoch: fixtureActiveSession().sessionEpoch,
      },
    });
  });

  it('derives owner, clock, and consent ID outside the accept body', async () => {
    const accept = vi.fn(async () => acceptedStatus('recorded'));
    const response = await createTermsConsentAcceptHandler(
      dependencies({ application: application({ accept }) }),
    )(
      request('POST', {
        body: JSON.stringify(termsConsentCommand()),
      }),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      outcome: 'recorded',
      status: {
        kind: 'accepted',
        accepted: { consentId: termsConsentIds.consentA },
      },
    });
    expect(accept).toHaveBeenCalledWith({
      context: {
        accountId: fixtureActiveSession().accountId,
        vaultId: fixtureActiveSession().vaultId,
        sessionId: fixtureActiveSession().sessionId,
        sessionEpoch: fixtureActiveSession().sessionEpoch,
      },
      command: termsConsentCommand(),
      consentId: termsConsentIds.consentA,
      acceptedAt: 1_500,
    });
  });

  it('rejects anonymous, cross-site, owner-injected, malformed, and oversized requests', async () => {
    const accept = vi.fn();
    const handler = createTermsConsentAcceptHandler(
      dependencies({ application: application({ accept }) }),
    );
    expect(
      (
        await handler(
          request('POST', {
            body: JSON.stringify(termsConsentCommand()),
            cookie: false,
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await handler(
          request('POST', {
            body: JSON.stringify(termsConsentCommand()),
            origin: 'https://attacker.example',
            site: 'cross-site',
          }),
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await handler(
          request('POST', {
            body: JSON.stringify({
              ...termsConsentCommand(),
              accountId: fixtureActiveSession().accountId,
            }),
          }),
        )
      ).status,
    ).toBe(400);
    expect((await handler(request('POST', { body: '{' }))).status).toBe(400);
    expect(
      (await handler(request('POST', { body: '{}', contentLength: '2049' })))
        .status,
    ).toBe(413);
    expect(accept).not.toHaveBeenCalled();
  });

  it.each([
    ['invalid-command', 400, 'invalid-request'],
    ['consent-required', 422, 'consent-required'],
    ['stale-terms', 409, 'terms-changed'],
    ['identifier-conflict', 409, 'request-conflict'],
    ['owner-mismatch', 403, 'forbidden'],
    ['classification-required', 503, 'unavailable'],
    ['hash-unavailable', 503, 'unavailable'],
  ] as const)(
    'maps application rejection %s without leaking internals',
    async (reason, status, error) => {
      const response = await createTermsConsentAcceptHandler(
        dependencies({
          application: application({
            accept: async () => ({ kind: 'rejected', reason }),
          }),
        }),
      )(request('POST', { body: JSON.stringify(termsConsentCommand()) }));
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error });
    },
  );

  it('fails closed for invalid clocks, generated IDs, and sessions', async () => {
    const body = JSON.stringify(termsConsentCommand());
    expect(
      (
        await createTermsConsentAcceptHandler(
          dependencies({ clock: { now: () => -1 } }),
        )(request('POST', { body }))
      ).status,
    ).toBe(503);
    expect(
      (
        await createTermsConsentAcceptHandler(
          dependencies({ consentIds: { create: () => 'invalid' } }),
        )(request('POST', { body }))
      ).status,
    ).toBe(503);
    expect(
      (
        await createTermsConsentStatusHandler(
          dependencies({
            sessions: { findSessionByToken: async () => undefined },
          }),
        )(request('GET'))
      ).status,
    ).toBe(401);
  });

  it('logs only a fixed category for secret-bearing failures', async () => {
    const failure = new Error(`message:${securityCorpusMarker}`);
    failure.name = `name:${securityCorpusMarker}`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const response = await createTermsConsentAcceptHandler(
      dependencies({
        application: application({
          accept: async () => {
            throw failure;
          },
        }),
      }),
    )(request('POST', { body: JSON.stringify(termsConsentCommand()) }));
    expect(response.status).toBe(503);
    expect(log).toHaveBeenCalledWith('terms consent request failed', 'Error');
    expect(
      containsSensitiveMarker(log.mock.calls, [securityCorpusMarker]),
    ).toBe(false);
  });
});

function dependencies(
  overrides: Partial<TermsConsentHttpDependencies> = {},
): TermsConsentHttpDependencies {
  return {
    expectedOrigin,
    clock: { now: () => 1_500 },
    consentIds: { create: () => termsConsentIds.consentA },
    sessions: { findSessionByToken: async () => fixtureActiveSession() },
    application: application(),
    ...overrides,
  };
}

function application(
  overrides: Partial<TermsConsentApplication> = {},
): TermsConsentApplication {
  return {
    status: async () => currentStatus(),
    accept: async () => acceptedStatus('recorded'),
    ...overrides,
  };
}

function currentStatus(): TermsConsentApplicationResult {
  const current = termsSnapshot();
  return {
    kind: 'accepted',
    outcome: 'status',
    status: {
      kind: 'current',
      acceptanceRequired: true,
      current: {
        termsVersion: current.termsVersion,
        termsHash: current.termsHash,
        effectiveDate: current.disclosure.effectiveDate,
      },
    },
  };
}

function acceptedStatus(
  outcome: 'recorded' | 'replayed',
): TermsConsentApplicationResult {
  const record = termsConsentRecord();
  return {
    kind: 'accepted',
    outcome,
    status: {
      kind: 'accepted',
      acceptanceRequired: false,
      current: {
        termsVersion: record.snapshot.termsVersion,
        termsHash: record.snapshot.termsHash,
        effectiveDate: record.snapshot.disclosure.effectiveDate,
      },
      accepted: {
        consentId: record.consentId,
        termsVersion: record.snapshot.termsVersion,
        termsHash: record.snapshot.termsHash,
        acceptedAt: record.acceptedAt,
      },
    },
  };
}

function request(
  method: 'GET' | 'POST',
  input: {
    readonly body?: string;
    readonly cookie?: boolean;
    readonly origin?: string;
    readonly site?: string;
    readonly contentLength?: string;
  } = {},
): Request {
  const headers = new Headers();
  if (input.cookie !== false) headers.set('cookie', cookieHeader());
  if (method === 'POST') {
    headers.set('content-type', 'application/json');
    headers.set('origin', input.origin ?? expectedOrigin);
    headers.set('sec-fetch-site', input.site ?? 'same-origin');
  }
  if (input.contentLength !== undefined) {
    headers.set('content-length', input.contentLength);
  }
  return new Request(`${expectedOrigin}/api/account/terms-consent`, {
    method,
    headers,
    ...(input.body === undefined ? {} : { body: input.body }),
  });
}
