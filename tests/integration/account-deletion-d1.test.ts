import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import {
  planAccountDeletionStart,
  planAccountDeletionStepClaim,
  planAccountDeletionStepResult,
  type AccountDeletionTransitionPlan,
} from '@/server/account-deletion/core';
import { D1AccountDeletionRepository } from '@/server/account-deletion/d1-adapter';
import { accountDeletionSagaMigration } from '@/server/account-deletion/migration';
import type {
  AccountDeletionOperation,
  AccountDeletionTransition,
} from '@/server/account-deletion/public';
import { identityVaultControlPlaneMigration } from '@/server/control-plane/migration';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import {
  accountDeletionFixtureIds,
  accountDeletionScopeFixture,
  requireDeletionOperation,
} from '@/tests/fixtures/account-deletion';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const manifest = [
  identityVaultControlPlaneMigration,
  accountDeletionSagaMigration,
] as const;

let miniflare: Miniflare;
let database: TestDatabase;
let malformedDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['ACCOUNT_DELETION', 'MALFORMED_ACCOUNT_DELETION'],
  });
  database = await miniflare.getD1Database('ACCOUNT_DELETION');
  malformedDatabase = await miniflare.getD1Database(
    'MALFORMED_ACCOUNT_DELETION',
  );
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('D1 account deletion saga repository', () => {
  it('applies the additive migration once without runtime DDL', async () => {
    expect(
      await runD1Migrations({ database, manifest, appliedAt: 1_000 }),
    ).toEqual({
      kind: 'applied',
      migrationIds: [
        '0002_identity_vault_control_plane',
        '0009_account_deletion_saga',
      ],
    });
    expect(
      await runD1Migrations({ database, manifest, appliedAt: 2_000 }),
    ).toEqual({ kind: 'up-to-date' });

    const rows: unknown[][] = await database
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'account_deletion_%' ORDER BY name",
      )
      .raw();
    expect(rows).toEqual([
      ['account_deletion_operations'],
      ['account_deletion_step_receipts'],
    ]);
  });

  it('creates once per Account, commits receipts atomically, replays safely, and rejects stale CAS', async () => {
    const repository = new D1AccountDeletionRepository(database);
    const initial = operation(accountDeletionFixtureIds.operationA);
    expect(await repository.create(initial)).toEqual({
      kind: 'created',
      snapshot: { operation: initial, receipts: [] },
    });
    expect(await repository.create(initial)).toEqual({
      kind: 'existing',
      snapshot: { operation: initial, receipts: [] },
    });
    expect(
      await repository.create(operation(accountDeletionFixtureIds.operationB)),
    ).toEqual({
      kind: 'existing',
      snapshot: { operation: initial, receipts: [] },
    });

    const claim = acceptedTransition(
      planAccountDeletionStepClaim({
        operation: initial,
        startedAt: 1_000,
        leaseExpiresAt: 2_000,
      }),
    );
    const appliedClaim = await repository.commit(
      accountDeletionScopeFixture(),
      claim,
    );
    expect(appliedClaim.kind).toBe('applied');
    expect(
      await repository.commit(accountDeletionScopeFixture(), claim),
    ).toEqual(
      appliedClaim.kind === 'applied'
        ? { kind: 'replayed', snapshot: appliedClaim.snapshot }
        : appliedClaim,
    );

    const staleClaim = acceptedTransition(
      planAccountDeletionStepClaim({
        operation: initial,
        startedAt: 1_001,
        leaseExpiresAt: 2_001,
      }),
    );
    expect(
      await repository.commit(accountDeletionScopeFixture(), staleClaim),
    ).toMatchObject({
      kind: 'conflict',
      current: { operation: { revision: 2 } },
    });

    const running = claim.next;
    if (running.state.kind !== 'running') throw new Error('not running');
    const success = acceptedTransition(
      planAccountDeletionStepResult({
        operation: running,
        result: {
          kind: 'succeeded',
          step: running.state.step,
          attempt: running.state.attempt,
          finishedAt: 1_100,
        },
        retryPolicy: { delaysMs: [100] },
      }),
    );
    const committed = await repository.commit(
      accountDeletionScopeFixture(),
      success,
    );
    expect(committed).toMatchObject({
      kind: 'applied',
      snapshot: {
        operation: {
          revision: 3,
          state: { kind: 'ready', step: 'cancel-subscription' },
        },
        receipts: [{ step: 'revoke-sessions', completedAt: 1_100 }],
      },
    });
    expect(
      await repository.commit(accountDeletionScopeFixture(), success),
    ).toEqual(
      committed.kind === 'applied'
        ? { kind: 'replayed', snapshot: committed.snapshot }
        : committed,
    );
  });

  it('requires both AccountId and VaultId for reads and commits', async () => {
    const repository = new D1AccountDeletionRepository(database);
    expect(
      await repository.findByOwner(accountDeletionScopeFixture('b')),
    ).toBeUndefined();
    const snapshot = await repository.findByOwner(
      accountDeletionScopeFixture(),
    );
    if (snapshot === undefined) throw new Error('operation missing');
    if (snapshot.operation.state.kind !== 'ready') {
      throw new Error('operation not ready');
    }
    const claim = acceptedTransition(
      planAccountDeletionStepClaim({
        operation: snapshot.operation,
        startedAt: 1_101,
        leaseExpiresAt: 2_101,
      }),
    );
    expect(
      await repository.commit(accountDeletionScopeFixture('b'), claim),
    ).toEqual({ kind: 'rejected', reason: 'invalid-transition' });
  });

  it('fails closed when D1 rows and receipts form an impossible snapshot', async () => {
    await runD1Migrations({
      database: malformedDatabase,
      manifest,
      appliedAt: 1_000,
    });
    const repository = new D1AccountDeletionRepository(malformedDatabase);
    await repository.create(operation(accountDeletionFixtureIds.operationA));
    await malformedDatabase
      .prepare(
        `UPDATE account_deletion_operations SET
          state = 'completed', current_step = NULL, attempt = 0,
          not_before = NULL, completed_at = updated_at`,
      )
      .run();
    await expect(
      repository.findByOwner(accountDeletionScopeFixture()),
    ).rejects.toBeInstanceOf(BoundaryDecodeError);
  });
});

function operation(
  operationId: (typeof accountDeletionFixtureIds)[keyof typeof accountDeletionFixtureIds],
): AccountDeletionOperation {
  return requireDeletionOperation(
    planAccountDeletionStart({
      operationId,
      scope: accountDeletionScopeFixture(),
      requestedAt: 1_000,
    }),
  );
}

function acceptedTransition(
  plan: AccountDeletionTransitionPlan,
): AccountDeletionTransition {
  if (plan.kind !== 'accepted') {
    throw new Error(`expected accepted transition, received ${plan.kind}`);
  }
  return plan.transition;
}
