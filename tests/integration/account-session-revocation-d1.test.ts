import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decodeOrThrow } from '@/lib/codec/core';
import {
  parseSessionEpoch,
  parseSessionId,
  type VaultContext,
} from '@/lib/domain/identity';
import {
  planAccountDeletionStart,
  planAccountDeletionStepClaim,
  planAccountDeletionStepResult,
} from '@/server/account-deletion/core';
import { D1AccountDeletionRepository } from '@/server/account-deletion/d1-adapter';
import { accountDeletionSagaMigration } from '@/server/account-deletion/migration';
import { executeRevokeSessionsStep } from '@/server/account-deletion/revoke-sessions';
import type {
  AccountDeletionOperation,
  AccountDeletionScope,
} from '@/server/account-deletion/public';
import {
  authorizeSession,
  createActiveSession,
  revokeSession,
} from '@/server/core/session';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { identityVaultControlPlaneMigration } from '@/server/control-plane/migration';
import {
  sessionTokenHashDecoder,
  type SessionTokenHash,
} from '@/server/control-plane/records';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { accountDeletionFixtureIds } from '@/tests/fixtures/account-deletion';
import {
  activeControlPlaneSession,
  controlPlaneIds,
  personalAccountProvision,
} from '@/tests/fixtures/control-plane';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const manifest = [
  identityVaultControlPlaneMigration,
  accountDeletionSagaMigration,
] as const;
const additionalIds = {
  sessionA2: parseSessionId('01991f20-61d2-7000-8000-000000001402'),
  sessionA3: parseSessionId('01991f20-61d2-7000-8000-000000001403'),
  sessionB: parseSessionId('01991f20-61d2-7000-8000-000000001404'),
  epoch2: parseSessionEpoch(2),
  epoch3: parseSessionEpoch(3),
} as const;

let miniflare: Miniflare;
let bulkDatabase: TestDatabase;
let sagaDatabase: TestDatabase;
let failureDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['BULK_REVOKE', 'SAGA_REVOKE', 'FAILURE_REVOKE'],
  });
  bulkDatabase = await miniflare.getD1Database('BULK_REVOKE');
  sagaDatabase = await miniflare.getD1Database('SAGA_REVOKE');
  failureDatabase = await miniflare.getD1Database('FAILURE_REVOKE');
  for (const database of [bulkDatabase, sagaDatabase, failureDatabase]) {
    await runD1Migrations({ database, manifest, appliedAt: 900 });
    await database.prepare('PRAGMA foreign_keys = ON').run();
  }
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('D1 Account-wide session revocation', () => {
  it('revokes every active epoch, preserves prior revocation, and isolates another Account', async () => {
    const adapter = new D1IdentityVaultControlPlane(bulkDatabase);
    await adapter.provisionPersonalAccount(personalAccountProvision());
    await adapter.provisionPersonalAccount(personalAccountProvision('b'));

    const first = activeControlPlaneSession();
    const second = activeSession({
      sessionId: additionalIds.sessionA2,
      accountId: controlPlaneIds.accountA,
      vaultId: controlPlaneIds.vaultA,
      sessionEpoch: additionalIds.epoch2,
      issuedAt: 1_100,
      expiresAt: 3_000,
    });
    const previouslyRevoked = activeSession({
      sessionId: additionalIds.sessionA3,
      accountId: controlPlaneIds.accountA,
      vaultId: controlPlaneIds.vaultA,
      sessionEpoch: additionalIds.epoch3,
      issuedAt: 1_200,
      expiresAt: 3_000,
    });
    const otherAccount = activeSession({
      sessionId: additionalIds.sessionB,
      accountId: controlPlaneIds.accountB,
      vaultId: controlPlaneIds.vaultB,
      sessionEpoch: additionalIds.epoch2,
      issuedAt: 1_000,
      expiresAt: 3_000,
    });
    const hashes = {
      first: tokenHash('A'),
      second: tokenHash('B'),
      previouslyRevoked: tokenHash('C'),
      otherAccount: tokenHash('D'),
    } as const;
    await storeSession(adapter, first, hashes.first);
    await storeSession(adapter, second, hashes.second);
    await storeSession(adapter, previouslyRevoked, hashes.previouslyRevoked);
    await storeSession(adapter, otherAccount, hashes.otherAccount);

    const priorRevocation = revokeSession(previouslyRevoked, 1_300, 'logout');
    if (priorRevocation.kind !== 'revoked') {
      throw new Error('invalid prior revocation fixture');
    }
    expect(
      await adapter.revokeSession(
        context(previouslyRevoked),
        priorRevocation.session,
      ),
    ).toEqual({ kind: 'applied' });

    const command = {
      accountId: controlPlaneIds.accountA,
      vaultId: controlPlaneIds.vaultA,
      revokedAt: 1_500,
    } as const;
    expect(await adapter.revokeAccountSessions(command)).toEqual({
      kind: 'applied',
      revokedSessionCount: 2,
    });
    expect(await adapter.revokeAccountSessions(command)).toEqual({
      kind: 'applied',
      revokedSessionCount: 0,
    });

    for (const hash of [hashes.first, hashes.second]) {
      const stored = await requiredStoredSession(adapter, hash);
      expect(stored.session).toMatchObject({
        kind: 'revoked',
        revokedAt: 1_500,
        reason: 'security',
      });
      expect(authorizeSession(stored.session, 1_600)).toEqual({
        kind: 'denied',
        reason: 'revoked',
      });
    }
    expect(
      (await requiredStoredSession(adapter, hashes.previouslyRevoked)).session,
    ).toEqual(priorRevocation.session);
    expect(
      (await requiredStoredSession(adapter, hashes.otherAccount)).session.kind,
    ).toBe('active');

    expect(
      await adapter.revokeAccountSessions({
        accountId: controlPlaneIds.accountA,
        vaultId: controlPlaneIds.vaultB,
        revokedAt: 1_600,
      }),
    ).toEqual({ kind: 'rejected', reason: 'owner-mismatch' });
    expect(
      (await requiredStoredSession(adapter, hashes.otherAccount)).session.kind,
    ).toBe('active');
  });

  it('connects a confirmed bulk revocation to the durable saga receipt', async () => {
    const controlPlane = new D1IdentityVaultControlPlane(sagaDatabase);
    await controlPlane.provisionPersonalAccount(personalAccountProvision());
    const session = activeControlPlaneSession();
    await storeSession(controlPlane, session, tokenHash('E'));
    const scope = deletionScope();
    const repository = new D1AccountDeletionRepository(sagaDatabase);
    const running = await persistRunningOperation(repository, scope);

    const execution = await executeRevokeSessionsStep({
      operation: running,
      revokedAt: 1_500,
      sessions: controlPlane,
    });
    expect(execution.kind).toBe('executed');
    if (execution.kind !== 'executed') return;
    const success = planAccountDeletionStepResult({
      operation: running,
      result: execution.result,
      retryPolicy: { delaysMs: [100] },
    });
    if (success.kind !== 'accepted') {
      throw new Error('revocation did not produce a saga transition');
    }
    expect(await repository.commit(scope, success.transition)).toMatchObject({
      kind: 'applied',
      snapshot: {
        operation: {
          state: { kind: 'ready', step: 'cancel-subscription' },
        },
        receipts: [{ step: 'revoke-sessions', completedAt: 1_500 }],
      },
    });
    expect(
      (await requiredStoredSession(controlPlane, tokenHash('E'))).session.kind,
    ).toBe('revoked');
  });

  it('rolls back a D1 failure and leaves the saga retryable without a receipt', async () => {
    const controlPlane = new D1IdentityVaultControlPlane(failureDatabase);
    await controlPlane.provisionPersonalAccount(personalAccountProvision());
    const hash = tokenHash('F');
    await storeSession(controlPlane, activeControlPlaneSession(), hash);
    await failureDatabase
      .prepare(
        `CREATE TRIGGER fail_session_revoke
         BEFORE UPDATE OF revoked_at ON sessions
         BEGIN SELECT RAISE(ABORT, 'fixture failure'); END`,
      )
      .run();
    const scope = deletionScope();
    const repository = new D1AccountDeletionRepository(failureDatabase);
    const running = await persistRunningOperation(repository, scope);

    const execution = await executeRevokeSessionsStep({
      operation: running,
      revokedAt: 1_500,
      sessions: controlPlane,
    });
    expect(execution).toMatchObject({
      kind: 'executed',
      result: {
        kind: 'retryable-failure',
        failureCode: 'session-revocation-unavailable',
      },
    });
    if (execution.kind !== 'executed') return;
    const retry = planAccountDeletionStepResult({
      operation: running,
      result: execution.result,
      retryPolicy: { delaysMs: [100] },
    });
    if (retry.kind !== 'accepted') {
      throw new Error('failure did not produce a retry transition');
    }
    expect(await repository.commit(scope, retry.transition)).toMatchObject({
      kind: 'applied',
      snapshot: {
        operation: { state: { kind: 'retry-wait' } },
        receipts: [],
      },
    });
    expect((await requiredStoredSession(controlPlane, hash)).session.kind).toBe(
      'active',
    );
  });
});

function activeSession(input: Parameters<typeof createActiveSession>[0]) {
  const decision = createActiveSession(input);
  if (decision.kind !== 'created') throw new Error('invalid session fixture');
  return decision.session;
}

function tokenHash(character: string): SessionTokenHash {
  return decodeOrThrow(
    sessionTokenHashDecoder,
    `${character.repeat(42)}A`,
    'session revocation token hash fixture',
  );
}

async function storeSession(
  adapter: D1IdentityVaultControlPlane,
  session: ReturnType<typeof activeSession>,
  tokenHashValue: SessionTokenHash,
): Promise<void> {
  expect(
    await adapter.createSession({ session, tokenHash: tokenHashValue }),
  ).toEqual({ kind: 'applied' });
}

async function requiredStoredSession(
  adapter: D1IdentityVaultControlPlane,
  hash: SessionTokenHash,
) {
  const stored = await adapter.findSessionByTokenHash(hash);
  if (stored === undefined) throw new Error('stored session fixture missing');
  return stored;
}

function context(session: ReturnType<typeof activeSession>): VaultContext {
  return {
    accountId: session.accountId,
    vaultId: session.vaultId,
    sessionId: session.sessionId,
    sessionEpoch: session.sessionEpoch,
  };
}

function deletionScope(): AccountDeletionScope {
  return {
    accountId: controlPlaneIds.accountA,
    vaultId: controlPlaneIds.vaultA,
  };
}

async function persistRunningOperation(
  repository: D1AccountDeletionRepository,
  scope: AccountDeletionScope,
): Promise<AccountDeletionOperation> {
  const start = planAccountDeletionStart({
    operationId: accountDeletionFixtureIds.operationA,
    scope,
    requestedAt: 1_000,
  });
  if (start.kind !== 'accepted') throw new Error('invalid deletion fixture');
  expect(await repository.create(start.operation)).toMatchObject({
    kind: 'created',
  });
  const claim = planAccountDeletionStepClaim({
    operation: start.operation,
    startedAt: 1_000,
    leaseExpiresAt: 2_000,
  });
  if (claim.kind !== 'accepted') throw new Error('invalid claim fixture');
  const committed = await repository.commit(scope, claim.transition);
  if (committed.kind !== 'applied') {
    throw new Error('claim was not persisted');
  }
  return committed.snapshot.operation;
}
