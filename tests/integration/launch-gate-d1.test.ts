import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleSyncRequest } from '@/app/api/sync/handler';
import {
  enforceLaunchGate,
  launchStatusResponse,
  sitesAuthenticatedUserIdHeader,
} from '@/server/launch-gate/http';
import { productionLaunchGateStatements } from '@/server/launch-gate/migration';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const allowedUserId = 'sites-user-allowed';
let miniflare: Miniflare;
let database: TestDatabase;

function request(userId?: string): Request {
  const headers = new Headers();
  if (userId !== undefined) {
    headers.set(sitesAuthenticatedUserIdHeader, userId);
  }
  return new Request('https://notes.example/api/launch-status', { headers });
}

async function configure(publicAccessEnabled: boolean): Promise<void> {
  await database
    .prepare(
      `UPDATE launch_config
       SET public_access_enabled = ?, updated_at = ?
       WHERE singleton = 1`,
    )
    .bind(publicAccessEnabled ? 1 : 0, 1)
    .run();
  await database
    .prepare(
      'INSERT INTO launch_allowed_users(user_id, created_at) VALUES (?, ?)',
    )
    .bind(allowedUserId, 1)
    .run();
}

async function resetDatabase(): Promise<void> {
  await database.exec(`
    DROP TABLE IF EXISTS launch_allowed_users;
    DROP TABLE IF EXISTS launch_config;
  `);
  for (const statement of productionLaunchGateStatements) {
    await database.prepare(statement).run();
  }
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['DB'],
  });
  database = await miniflare.getD1Database('DB');
});

beforeEach(resetDatabase);

afterAll(async () => {
  await miniflare.dispose();
});

describe('Production Launch Gate D1 and HTTP boundary', () => {
  it.each([
    [false, allowedUserId, true, true],
    [false, 'sites-user-not-allowed', false, false],
    [true, allowedUserId, true, true],
    [true, 'sites-user-not-allowed', false, true],
  ])(
    'evaluates public=%s user=%s',
    async (publicAccessEnabled, userId, userAllowed, canAccess) => {
      await configure(publicAccessEnabled);
      const response = await launchStatusResponse(
        request(userId),
        { DB: database },
        'production',
      );

      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        publicAccessEnabled,
        userAllowed,
        canAccess,
        authenticated: true,
      });
      expect(response.headers.get('cache-control')).toBe('private, no-store');
      expect(response.headers.get('vary')).toContain('Cookie');
      expect(response.headers.get('vary')).toContain(
        sitesAuthenticatedUserIdHeader,
      );
    },
  );

  it('denies an unauthenticated or unknown identity while private', async () => {
    await configure(false);

    for (const candidate of [undefined, 'missing-user']) {
      const response = await enforceLaunchGate(
        request(candidate),
        { DB: database },
        'production',
      );
      expect(response?.status).toBe(403);
      expect(await response?.json()).toEqual({
        error: 'launch-access-denied',
      });
    }
  });

  it('fails closed for a missing table, missing singleton, or malformed identity', async () => {
    await database.prepare('DELETE FROM launch_config').run();
    expect(
      (
        await enforceLaunchGate(
          request(allowedUserId),
          { DB: database },
          'production',
        )
      )?.status,
    ).toBe(503);

    await resetDatabase();
    await database.prepare('DROP TABLE launch_config').run();
    expect(
      (
        await enforceLaunchGate(
          request(allowedUserId),
          { DB: database },
          'production',
        )
      )?.status,
    ).toBe(503);

    expect(
      (
        await enforceLaunchGate(
          request(' padded '),
          { DB: database },
          'production',
        )
      )?.status,
    ).toBe(503);
  });

  it('enforces the gate before parsing a direct sync API request', async () => {
    await configure(false);
    const directRequest = (userId: string) =>
      new Request('https://notes.example/api/sync', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [sitesAuthenticatedUserIdHeader]: userId,
        },
        body: '{}',
      });

    const denied = await handleSyncRequest(
      directRequest('sites-user-not-allowed'),
      { DB: database, FUKAMU_SERVICE_MODE: 'legacy-test' },
      'production',
    );
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'launch-access-denied' });

    const allowed = await handleSyncRequest(
      directRequest(allowedUserId),
      { DB: database, FUKAMU_SERVICE_MODE: 'legacy-test' },
      'production',
    );
    expect(allowed.status).toBe(400);
  });

  it('does not require Launch Gate storage in test mode', async () => {
    const response = await launchStatusResponse(request(), {}, 'test');
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      publicAccessEnabled: true,
      canAccess: true,
    });
  });
});
