import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { planAccountDeletionStart } from '@/server/account-deletion/core';
import { D1AccountDeletionRepository } from '@/server/account-deletion/d1-adapter';
import { planAccountDeletionContinuationStart } from '@/server/account-deletion/http-core';
import { accountDeletionContinuationMigration } from '@/server/account-deletion/continuation-migration';
import { accountDeletionSagaMigration } from '@/server/account-deletion/migration';
import {
  accountDeletionContinuationSequenceDecoder,
  parseAccountDeletionCredentialHash,
} from '@/server/account-deletion/public';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import {
  accountDeletionFixtureIds,
  accountDeletionScopeFixture,
  requireDeletionOperation,
} from '@/tests/fixtures/account-deletion';
import { decodeOrThrow } from '@/lib/codec/core';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const manifest = [
  accountDeletionSagaMigration,
  accountDeletionContinuationMigration,
] as const;
const idempotencyKeyHash = parseAccountDeletionCredentialHash('H'.repeat(43));
const secretHash = parseAccountDeletionCredentialHash('D'.repeat(43));
const otherHash = parseAccountDeletionCredentialHash('E'.repeat(43));

let miniflare: Miniflare;
let database: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['ACCOUNT_DELETION_CONTINUATION'],
  });
  database = await miniflare.getD1Database('ACCOUNT_DELETION_CONTINUATION');
  await runD1Migrations({ database, manifest, appliedAt: 900 });
  await database.prepare('PRAGMA foreign_keys = ON').run();
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('D1 account deletion continuation access', () => {
  it('atomically starts once, stores hashes only, and rejects another credential', async () => {
    const repository = new D1AccountDeletionRepository(database);
    const started = await repository.startWithContinuation(
      startInput(accountDeletionFixtureIds.operationA, 1_000),
    );
    expect(started).toMatchObject({
      kind: 'created',
      snapshot: {
        operation: { operationId: accountDeletionFixtureIds.operationA },
      },
      continuation: { sequence: 0, expiresAt: 2_000 },
    });

    const duplicate = await repository.startWithContinuation(
      startInput(accountDeletionFixtureIds.operationB, 1_100),
    );
    expect(duplicate).toMatchObject({
      kind: 'existing',
      snapshot: {
        operation: { operationId: accountDeletionFixtureIds.operationA },
      },
      continuation: { sequence: 0, expiresAt: 2_100 },
    });
    expect(
      await repository.startWithContinuation(
        startInput(
          accountDeletionFixtureIds.operationB,
          1_101,
          otherHash,
          otherHash,
        ),
      ),
    ).toEqual({ kind: 'rejected', reason: 'credential-conflict' });

    const stored: unknown = await database
      .prepare(
        `SELECT idempotency_key_hash, secret_hash, sequence, expires_at
         FROM account_deletion_continuations`,
      )
      .first();
    expect(stored).toMatchObject({
      idempotency_key_hash: idempotencyKeyHash,
      secret_hash: secretHash,
      sequence: 0,
      expires_at: 2_100,
    });
    const serialized = JSON.stringify(stored);
    expect(serialized).not.toContain('I'.repeat(43));
    expect(serialized).not.toContain('S'.repeat(43));
  });

  it('uses sequence CAS, recovers one immediate duplicate, and rejects stale or expired access', async () => {
    const repository = new D1AccountDeletionRepository(database);
    const first = await repository.consumeContinuation({
      secretHash,
      sequence: sequence(0),
      consumedAt: 1_200,
    });
    expect(first).toMatchObject({
      kind: 'consumed',
      continuation: { sequence: 1 },
    });
    expect(
      await repository.consumeContinuation({
        secretHash,
        sequence: sequence(0),
        consumedAt: 1_201,
      }),
    ).toMatchObject({ kind: 'replayed', continuation: { sequence: 1 } });
    expect(
      await repository.consumeContinuation({
        secretHash,
        sequence: sequence(1),
        consumedAt: 1_202,
      }),
    ).toMatchObject({ kind: 'consumed', continuation: { sequence: 2 } });
    expect(
      await repository.consumeContinuation({
        secretHash,
        sequence: sequence(0),
        consumedAt: 1_203,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-capability' });
    expect(
      await repository.consumeContinuation({
        secretHash: otherHash,
        sequence: sequence(2),
        consumedAt: 1_204,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-capability' });
    expect(
      await repository.consumeContinuation({
        secretHash,
        sequence: sequence(2),
        consumedAt: 2_100,
      }),
    ).toEqual({ kind: 'rejected', reason: 'expired' });
  });
});

function startInput(
  operationId: (typeof accountDeletionFixtureIds)[keyof typeof accountDeletionFixtureIds],
  requestedAt: number,
  requestedIdempotencyHash = idempotencyKeyHash,
  requestedSecretHash = secretHash,
) {
  const operation = requireDeletionOperation(
    planAccountDeletionStart({
      operationId,
      scope: accountDeletionScopeFixture(),
      requestedAt,
    }),
  );
  const continuation = planAccountDeletionContinuationStart({
    operation,
    idempotencyKeyHash: requestedIdempotencyHash,
    secretHash: requestedSecretHash,
    expiresAt: requestedAt + 1_000,
  });
  if (continuation.kind !== 'accepted') {
    throw new Error('invalid continuation fixture');
  }
  return { operation, continuation: continuation.continuation };
}

function sequence(value: number) {
  return decodeOrThrow(
    accountDeletionContinuationSequenceDecoder,
    value,
    'test continuation sequence',
  );
}
