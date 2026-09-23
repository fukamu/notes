import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createAccountDeletionApplication } from '@/server/account-deletion/application';
import { accountDeletionContinuationMigration } from '@/server/account-deletion/continuation-migration';
import { D1AccountDeletionRepository } from '@/server/account-deletion/d1-adapter';
import { accountDeletionSagaMigration } from '@/server/account-deletion/migration';
import {
  parseAccountDeletionContinuationSecret,
  parseAccountDeletionCredentialHash,
  parseAccountDeletionIdempotencyKey,
  parseAccountDeletionOperationId,
  parseAccountDeletionContinuationToken,
  type AccountDeletionApplicationResult,
  type AccountDeletionContinuationToken,
} from '@/server/account-deletion/public';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { accountDeletionScopeFixture } from '@/tests/fixtures/account-deletion';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const manifest = [
  accountDeletionSagaMigration,
  accountDeletionContinuationMigration,
] as const;
const operationId = parseAccountDeletionOperationId(
  '01991f20-61d2-7000-8000-000000000901',
);
const nextOperationId = parseAccountDeletionOperationId(
  '01991f20-61d2-7000-8000-000000000902',
);
const idempotencyKey = parseAccountDeletionIdempotencyKey('I'.repeat(43));
const otherIdempotencyKey = parseAccountDeletionIdempotencyKey('J'.repeat(43));
const secret = parseAccountDeletionContinuationSecret('S'.repeat(43));
const idempotencyHash = parseAccountDeletionCredentialHash('H'.repeat(43));
const otherIdempotencyHash = parseAccountDeletionCredentialHash('Q'.repeat(43));
const secretHash = parseAccountDeletionCredentialHash('D'.repeat(43));

let miniflare: Miniflare;
let database: TestDatabase;
let failureDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: [
      'ACCOUNT_DELETION_APPLICATION',
      'ACCOUNT_DELETION_APPLICATION_FAILURE',
    ],
  });
  database = await miniflare.getD1Database('ACCOUNT_DELETION_APPLICATION');
  failureDatabase = await miniflare.getD1Database(
    'ACCOUNT_DELETION_APPLICATION_FAILURE',
  );
  for (const target of [database, failureDatabase]) {
    await runD1Migrations({ database: target, manifest, appliedAt: 900 });
    await target.prepare('PRAGMA foreign_keys = ON').run();
  }
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('account deletion application', () => {
  it('returns a capability before revocation, dispatches one ordered step per resume, and deduplicates replay', async () => {
    const effects = successfulEffects();
    const application = createAccountDeletionApplication({
      repository: new D1AccountDeletionRepository(database),
      operationIds: sequentialOperationIds(),
      credentials: credentials(),
      continuationLifetimeMs: 10_000,
      leaseDurationMs: 1_000,
      retryPolicy: { delaysMs: [100, 200] },
      ...effects.ports,
    });

    const started = await application.start({
      scope: accountDeletionScopeFixture(),
      idempotencyKey,
      requestedAt: 1_000,
    });
    expect(started).toMatchObject({
      kind: 'accepted',
      status: { kind: 'in-progress' },
    });
    expect(effects.calls).toEqual([]);
    const token0 = continuationToken(started);

    const revoked = await application.resume({
      token: token0,
      resumedAt: 1_100,
    });
    expect(revoked).toMatchObject({
      kind: 'accepted',
      status: { kind: 'in-progress' },
    });
    expect(effects.calls).toEqual(['sessions']);
    const token1 = continuationToken(revoked);

    const replay = await application.resume({
      token: token0,
      resumedAt: 1_101,
    });
    expect(replay).toMatchObject({
      kind: 'accepted',
      continuationToken: token1,
    });
    expect(effects.calls).toEqual(['sessions']);

    let current = token1;
    for (const [index, expected] of [
      'billing',
      'metadata',
      'objects',
      'barrier',
    ].entries()) {
      const result = await application.resume({
        token: current,
        resumedAt: 1_200 + index * 100,
      });
      expect(effects.calls).toContain(expected);
      if (index < 3) current = continuationToken(result);
      else {
        expect(result).toEqual({
          kind: 'accepted',
          status: { kind: 'completed' },
        });
      }
    }
    expect(effects.calls).toEqual([
      'sessions',
      'billing',
      'metadata',
      'content',
      'objects',
      'barrier',
      'keys',
      'account',
    ]);
  });

  it('rejects another idempotency credential and a guessed continuation without disclosing scope', async () => {
    const effects = successfulEffects();
    const application = createAccountDeletionApplication({
      repository: new D1AccountDeletionRepository(database),
      operationIds: sequentialOperationIds(),
      credentials: credentials(),
      continuationLifetimeMs: 10_000,
      leaseDurationMs: 1_000,
      retryPolicy: { delaysMs: [100] },
      ...effects.ports,
    });
    expect(
      await application.start({
        scope: accountDeletionScopeFixture(),
        idempotencyKey: otherIdempotencyKey,
        requestedAt: 1_700,
      }),
    ).toEqual({ kind: 'rejected', reason: 'credential-conflict' });

    const guessed = parseAccountDeletionContinuationToken(
      `${'ad1.'}${'G'.repeat(43)}.0`,
    );
    const result = await application.resume({
      token: guessed,
      resumedAt: 1_701,
    });
    expect(result).toEqual({ kind: 'rejected', reason: 'invalid-capability' });
    expect(JSON.stringify(result)).not.toMatch(/account|vault|operation/);
  });

  it('holds a typed retry state after an effect failure and resumes only when due', async () => {
    const effects = successfulEffects();
    let cancellationCalls = 0;
    const application = createAccountDeletionApplication({
      repository: new D1AccountDeletionRepository(failureDatabase),
      operationIds: sequentialOperationIds(),
      credentials: credentials(),
      continuationLifetimeMs: 10_000,
      leaseDurationMs: 1_000,
      retryPolicy: { delaysMs: [100] },
      ...effects.ports,
      billing: {
        cancelSubscriptionImmediately: async () => {
          cancellationCalls += 1;
          if (cancellationCalls === 1) {
            throw new Error('injected provider outage');
          }
          return {
            kind: 'confirmed',
            outcome: 'cancelled',
            confirmedAt: 1_301,
            accessEndsAt: 1_301,
          };
        },
      },
    });
    const started = await application.start({
      scope: accountDeletionScopeFixture(),
      idempotencyKey,
      requestedAt: 1_000,
    });
    const afterRevoke = await application.resume({
      token: continuationToken(started),
      resumedAt: 1_100,
    });
    const failed = await application.resume({
      token: continuationToken(afterRevoke),
      resumedAt: 1_200,
    });
    expect(failed).toMatchObject({
      kind: 'accepted',
      status: { kind: 'retry-wait', retryAt: 1_300 },
    });
    expect(cancellationCalls).toBe(1);

    const early = await application.resume({
      token: continuationToken(failed),
      resumedAt: 1_250,
    });
    expect(early).toMatchObject({
      status: { kind: 'retry-wait', retryAt: 1_300 },
    });
    expect(cancellationCalls).toBe(1);

    const ready = await application.resume({
      token: continuationToken(early),
      resumedAt: 1_300,
    });
    expect(ready).toMatchObject({ status: { kind: 'in-progress' } });
    expect(cancellationCalls).toBe(1);

    const resumed = await application.resume({
      token: continuationToken(ready),
      resumedAt: 1_301,
    });
    expect(resumed).toMatchObject({ status: { kind: 'in-progress' } });
    expect(cancellationCalls).toBe(2);
  });
});

function credentials() {
  return {
    async digest(value: string) {
      if (value === idempotencyKey) return idempotencyHash;
      if (value === otherIdempotencyKey) return otherIdempotencyHash;
      if (value === secret) return secretHash;
      return parseAccountDeletionCredentialHash('Z'.repeat(43));
    },
    async deriveSecret() {
      return secret;
    },
  };
}

function sequentialOperationIds() {
  const values = [operationId, nextOperationId];
  let index = 0;
  return {
    create() {
      const value = values[index] ?? nextOperationId;
      index += 1;
      return value;
    },
  };
}

function successfulEffects() {
  const calls: string[] = [];
  return {
    calls,
    ports: {
      sessions: {
        revokeAccountSessions: vi.fn(async () => {
          calls.push('sessions');
          return { kind: 'applied' as const, revokedSessionCount: 1 };
        }),
      },
      billing: {
        cancelSubscriptionImmediately: vi.fn(async () => {
          calls.push('billing');
          return {
            kind: 'confirmed' as const,
            outcome: 'cancelled' as const,
            confirmedAt: 1_200,
            accessEndsAt: 1_200,
          };
        }),
      },
      encryptedObjects: {
        purgeVaultMetadata: vi.fn(async () => {
          calls.push('metadata');
          return { kind: 'confirmed' as const, outcome: 'purged' as const };
        }),
        purgeVaultPrivateObjects: vi.fn(async () => {
          calls.push('objects');
          return { kind: 'confirmed' as const, outcome: 'deleted' as const };
        }),
        confirmVaultPrivateObjectDeletion: vi.fn(async () => {
          calls.push('barrier');
          return { kind: 'confirmed' as const, outcome: 'empty' as const };
        }),
      },
      vaultContent: {
        purgeVaultLiveData: vi.fn(async () => {
          calls.push('content');
          return { kind: 'confirmed' as const, outcome: 'purged' as const };
        }),
      },
      wrappedKeys: {
        finalizeVaultWrappedKeys: vi.fn(async () => {
          calls.push('keys');
          return { kind: 'confirmed' as const, outcome: 'deleted' as const };
        }),
      },
      controlPlane: {
        finalizeAccountLiveState: vi.fn(async () => {
          calls.push('account');
          return { kind: 'confirmed' as const, outcome: 'deleted' as const };
        }),
      },
    },
  };
}

function continuationToken(
  result: AccountDeletionApplicationResult,
): AccountDeletionContinuationToken {
  if (result.kind !== 'accepted' || !('continuationToken' in result)) {
    throw new Error('continuation token missing');
  }
  return result.continuationToken;
}
