import { describe, expect, it, vi } from 'vitest';
import {
  createSyncV2HttpHandler,
  type SyncV2HttpDependencies,
} from '@/app/api/v2/sync/handler';
import {
  encodeSyncV2Request,
  parseSyncSequence,
  parseSyncV2Cursor,
} from '@/lib/sync/v2-protocol';
import { createCompatibilityFixture } from '@/tests/fixtures/compatibility';
import {
  containsSensitiveMarker,
  securityCorpusMarker,
} from '@/tests/fixtures/security-corpus';
import { cookieHeader, fixtureActiveSession } from '@/tests/fixtures/session';
import type { SyncV2ApplicationInput } from '@/server/sync-v2/public';
import { paidPersonalVaultLimits } from '@/server/entitlement/public';
import { createFakeTelemetrySink } from '@/server/telemetry/fake';

const expectedOrigin = 'https://notes.example';
const nextCursor = parseSyncV2Cursor(
  'sync.v2.page.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
);

function request(
  input: {
    readonly cookie?: string;
    readonly origin?: string;
    readonly site?: string;
    readonly body?: string;
    readonly contentLength?: string;
  } = {},
): Request {
  const fixture = createCompatibilityFixture();
  const body =
    input.body ??
    JSON.stringify(
      encodeSyncV2Request({
        deviceId: fixture.request.deviceId,
        cursor: null,
        mutations: [],
      }),
    );
  const headers = new Headers({
    'content-type': 'application/json',
    cookie: input.cookie ?? cookieHeader(),
    origin: input.origin ?? expectedOrigin,
    'sec-fetch-site': input.site ?? 'same-origin',
  });
  if (input.contentLength !== undefined) {
    headers.set('content-length', input.contentLength);
  }
  return new Request(`${expectedOrigin}/api/v2/sync`, {
    method: 'POST',
    headers,
    body,
  });
}

function dependencies(
  overrides: Partial<SyncV2HttpDependencies> = {},
): SyncV2HttpDependencies {
  return {
    expectedOrigin,
    clock: { now: () => 1_500 },
    sessions: {
      findSessionByToken: async () => fixtureActiveSession(),
    },
    entitlement: {
      authorizeCapability: async (_context, capability) => ({
        kind: 'allowed',
        capability,
        basis: 'trial',
        validUntil: 2_000,
      }),
      readLimits: async () => ({
        kind: 'available',
        limits: paidPersonalVaultLimits,
        validUntil: 2_000,
      }),
    },
    application: {
      synchronize: async () => ({
        kind: 'synchronized',
        response: {
          version: 'sync/v2',
          highWatermark: parseSyncSequence(0),
          changes: [],
          receipts: [],
          page: { kind: 'complete', nextCursor },
        },
      }),
    },
    ...overrides,
  };
}

function synchronizeSpy() {
  const application = dependencies().application;
  return vi.fn((input: SyncV2ApplicationInput) =>
    application.synchronize(input),
  );
}

describe('authenticated Sync v2 HTTP handler', () => {
  it('derives VaultContext, checks notes-sync, and returns no-store JSON', async () => {
    const entitlement = vi.fn(dependencies().entitlement.authorizeCapability);
    const readLimits = vi.fn(dependencies().entitlement.readLimits);
    const synchronize = synchronizeSpy();
    const telemetry = createFakeTelemetrySink();
    const syncRequest = request();
    const expectedRequestBytes = (await syncRequest.clone().arrayBuffer())
      .byteLength;
    const response = await createSyncV2HttpHandler(
      dependencies({
        entitlement: { authorizeCapability: entitlement, readLimits },
        application: { synchronize },
        telemetry: telemetry.sink,
      }),
    )(syncRequest);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(entitlement).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: fixtureActiveSession().vaultId }),
      'notes-sync',
      1_500,
    );
    expect(synchronize).toHaveBeenCalledOnce();
    expect(readLimits).toHaveBeenCalledWith(
      expect.objectContaining({ vaultId: fixtureActiveSession().vaultId }),
      1_500,
    );
    const [synchronizeCall] = synchronize.mock.calls;
    expect(synchronizeCall?.[0].limits).toEqual(paidPersonalVaultLimits);
    expect(synchronizeCall?.[0].requestBytes).toBe(expectedRequestBytes);
    await expect(response.json()).resolves.toMatchObject({
      version: 'sync/v2',
      page: { kind: 'complete' },
    });
    expect(telemetry.records()).toEqual([
      {
        schemaVersion: 1,
        operation: 'sync-v2',
        outcome: 'no-change',
        failureCategory: 'none',
        durationBucket: 'not-measured',
        workItemsBucket: 'zero',
      },
    ]);
  });

  it('rejects anonymous and cross-site requests before application work', async () => {
    const synchronize = synchronizeSpy();
    const anonymous = await createSyncV2HttpHandler(
      dependencies({
        sessions: { findSessionByToken: async () => undefined },
        application: { synchronize },
      }),
    )(request());
    expect(anonymous.status).toBe(401);

    const lookup = vi.fn(dependencies().sessions.findSessionByToken);
    const csrf = await createSyncV2HttpHandler(
      dependencies({
        sessions: { findSessionByToken: lookup },
        application: { synchronize },
      }),
    )(request({ origin: 'https://attacker.example', site: 'cross-site' }));
    expect(csrf.status).toBe(403);
    expect(lookup).not.toHaveBeenCalled();
    expect(synchronize).not.toHaveBeenCalled();
  });

  it('locks online sync immediately for denied entitlement', async () => {
    const synchronize = synchronizeSpy();
    const telemetry = createFakeTelemetrySink();
    const response = await createSyncV2HttpHandler(
      dependencies({
        entitlement: {
          authorizeCapability: async (_context, capability) => ({
            kind: 'denied',
            capability,
            reason: 'payment-failed',
          }),
          readLimits: async () => ({
            kind: 'denied',
            reason: 'payment-failed',
          }),
        },
        application: { synchronize },
        telemetry: telemetry.sink,
      }),
    )(request());
    expect(response.status).toBe(402);
    await expect(response.json()).resolves.toEqual({
      error: 'online-access-locked',
    });
    expect(synchronize).not.toHaveBeenCalled();
    expect(telemetry.records()).toEqual([
      expect.objectContaining({
        operation: 'sync-v2',
        outcome: 'locked',
        failureCategory: 'billing',
      }),
    ]);
  });

  it('rejects unavailable limits before application work', async () => {
    const synchronize = synchronizeSpy();
    const response = await createSyncV2HttpHandler(
      dependencies({
        entitlement: {
          authorizeCapability: dependencies().entitlement.authorizeCapability,
          readLimits: async () => ({
            kind: 'denied',
            reason: 'entitlement-unavailable',
          }),
        },
        application: { synchronize },
      }),
    )(request());
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: 'unavailable' });
    expect(synchronize).not.toHaveBeenCalled();
  });

  it('rejects malformed and oversized bodies without weakening the boundary', async () => {
    const handler = createSyncV2HttpHandler(dependencies());
    expect((await handler(request({ body: '{' }))).status).toBe(400);
    expect(
      (await handler(request({ body: '{}', contentLength: '4000001' }))).status,
    ).toBe(413);
  });

  it('maps expected application rejection without exposing tenant details', async () => {
    const response = await createSyncV2HttpHandler(
      dependencies({
        application: {
          synchronize: async () => ({
            kind: 'rejected',
            reason: 'invalid-cursor',
          }),
        },
      }),
    )(request());
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: 'invalid-request',
    });
  });

  it('logs only a fixed category for secret-bearing unexpected failures', async () => {
    const failure = new Error(`message:${securityCorpusMarker}`);
    failure.name = `name:${securityCorpusMarker}`;
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const telemetry = createFakeTelemetrySink();
    const response = await createSyncV2HttpHandler(
      dependencies({
        application: {
          synchronize: async () => {
            throw failure;
          },
        },
        telemetry: telemetry.sink,
      }),
    )(request());

    expect(response.status).toBe(503);
    expect(response.headers.get('cache-control')).toBe('no-store');
    await expect(response.json()).resolves.toEqual({ error: 'unavailable' });
    expect(log).toHaveBeenCalledWith('sync v2 failed', 'Error');
    expect(
      containsSensitiveMarker(log.mock.calls, [securityCorpusMarker]),
    ).toBe(false);
    expect(telemetry.records()).toEqual([
      expect.objectContaining({
        operation: 'sync-v2',
        outcome: 'failure',
        failureCategory: 'internal',
      }),
    ]);
    expect(JSON.stringify(telemetry.records())).not.toContain(
      securityCorpusMarker,
    );
  });

  it('does not change a successful response when telemetry recording fails', async () => {
    const telemetry = createFakeTelemetrySink({ failAfterRecords: 0 });
    const response = await createSyncV2HttpHandler(
      dependencies({ telemetry: telemetry.sink }),
    )(request());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      version: 'sync/v2',
      page: { kind: 'complete' },
    });
    expect(telemetry.records()).toEqual([]);
  });

  it.each([
    ['ciphertext-limit', 413, 'encrypted-content-too-large'],
    ['active-card-limit', 409, 'quota-exceeded'],
    ['vault-plaintext-limit', 409, 'quota-exceeded'],
    ['quota-unavailable', 503, 'unavailable'],
  ] as const)(
    'maps %s without exposing storage details',
    async (reason, status, error) => {
      const response = await createSyncV2HttpHandler(
        dependencies({
          application: {
            synchronize: async () => ({ kind: 'rejected', reason }),
          },
        }),
      )(request());
      expect(response.status).toBe(status);
      await expect(response.json()).resolves.toEqual({ error });
    },
  );
});
