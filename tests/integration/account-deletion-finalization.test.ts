import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
  stringDecoder,
} from '@/lib/codec/core';
import {
  parseAccountId,
  parseIdentityId,
  parseVaultId,
  type VaultId,
} from '@/lib/domain/identity';
import {
  planAccountDeletionStart,
  planAccountDeletionStepClaim,
  planAccountDeletionStepResult,
} from '@/server/account-deletion/core';
import { executeFinalizeAccountStep } from '@/server/account-deletion/finalize-account';
import type {
  AccountDeletionOperation,
  AccountDeletionSnapshot,
  AccountDeletionStep,
  AccountDeletionStepReceipt,
  AccountDeletionTransition,
} from '@/server/account-deletion/public';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { D1VaultWrappedKeyFinalization } from '@/server/crypto/d1-finalization';
import { D1VaultPrivateObjectDeletionBarrier } from '@/server/encrypted-object/d1-adapter';
import type { OpaqueObjectKey } from '@/server/encrypted-object/core';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import {
  accountDeletionFixtureIds,
  requireDeletionOperation,
} from '@/tests/fixtures/account-deletion';
import {
  activeControlPlaneSession,
  controlPlaneIds,
  controlPlaneTokenHash,
  personalAccountProvision,
} from '@/tests/fixtures/control-plane';
import { envelopeCryptoIds } from '@/tests/fixtures/envelope-crypto';
import { encryptedObjectIds } from '@/tests/fixtures/encrypted-object';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const countDecoder = objectDecoder(
  { count: safeIntegerDecoder({ minimum: 0 }) },
  { unknownFields: 'allow' },
);
const snapshotDecoder = objectDecoder(
  { snapshot: stringDecoder({ maxLength: 100_000 }) },
  { unknownFields: 'allow' },
);

let miniflare: Miniflare;
let successDatabase: TestDatabase;
let failureDatabase: TestDatabase;
let outboxDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['SUCCESS', 'FAILURE', 'OUTBOX'],
  });
  successDatabase = await miniflare.getD1Database('SUCCESS');
  failureDatabase = await miniflare.getD1Database('FAILURE');
  outboxDatabase = await miniflare.getD1Database('OUTBOX');
  for (const database of [successDatabase, failureDatabase, outboxDatabase]) {
    await runD1Migrations({
      database,
      manifest: productionMigrationManifest,
      appliedAt: 1_000,
    });
    await database.prepare('PRAGMA foreign_keys = ON').run();
    await seedTwoOwners(database);
  }
  await enqueue(
    outboxDatabase,
    controlPlaneIds.vaultA,
    encryptedObjectIds.objectKeyA,
  );
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('account deletion finalization', () => {
  it('deletes only the exact owner, rejects old login/session, and replays idempotently', async () => {
    const controlPlane = new D1IdentityVaultControlPlane(successDatabase);
    const wrappedKeys = new D1VaultWrappedKeyFinalization(successDatabase);
    const privateObjects = new D1VaultPrivateObjectDeletionBarrier(
      successDatabase,
    );
    const snapshotB = await ownerSnapshot(
      successDatabase,
      controlPlaneIds.vaultB,
    );
    const mismatch = {
      accountId: controlPlaneIds.accountA,
      vaultId: controlPlaneIds.vaultB,
    };
    await expect(
      privateObjects.confirmVaultPrivateObjectDeletion(mismatch),
    ).resolves.toEqual({
      kind: 'terminal-failure',
      reason: 'owner-mismatch',
    });
    await expect(
      wrappedKeys.finalizeVaultWrappedKeys(mismatch),
    ).resolves.toEqual({
      kind: 'terminal-failure',
      reason: 'owner-mismatch',
    });
    await expect(
      controlPlane.finalizeAccountLiveState(mismatch),
    ).resolves.toEqual({
      kind: 'terminal-failure',
      reason: 'owner-mismatch',
    });
    expect(await ownerSnapshot(successDatabase, controlPlaneIds.vaultB)).toBe(
      snapshotB,
    );

    const first = await executeFinalizeAccountStep({
      snapshot: finalizationRunningSnapshot(),
      executedAt: 1_500,
      privateObjects,
      wrappedKeys,
      controlPlane,
    });
    expect(first).toMatchObject({
      kind: 'executed',
      result: { kind: 'succeeded', step: 'finalize-account' },
    });
    expect(await ownerLiveCount(successDatabase, controlPlaneIds.vaultA)).toBe(
      0,
    );
    expect(await ownerSnapshot(successDatabase, controlPlaneIds.vaultB)).toBe(
      snapshotB,
    );

    const provision = personalAccountProvision('a');
    await expect(
      controlPlane.findPersonalAccount(controlPlaneIds.accountA),
    ).resolves.toBeUndefined();
    await expect(
      controlPlane.findIdentity({
        provider: provision.identity.provider,
        issuer: provision.identity.issuer,
        subject: provision.identity.subject,
      }),
    ).resolves.toBeUndefined();
    await expect(
      controlPlane.findSessionByTokenHash(controlPlaneTokenHash),
    ).resolves.toBeUndefined();

    await expect(
      executeFinalizeAccountStep({
        snapshot: finalizationRunningSnapshot(),
        executedAt: 1_500,
        privateObjects,
        wrappedKeys,
        controlPlane,
      }),
    ).resolves.toMatchObject({
      kind: 'executed',
      result: { kind: 'succeeded' },
    });

    const replacement = replacementProvision();
    await expect(
      controlPlane.provisionPersonalAccount(replacement),
    ).resolves.toEqual({ kind: 'applied' });
    await expect(
      controlPlane.findIdentity({
        provider: replacement.identity.provider,
        issuer: replacement.identity.issuer,
        subject: replacement.identity.subject,
      }),
    ).resolves.toMatchObject({ accountId: replacement.account.accountId });
    expect(replacement.account.accountId).not.toBe(controlPlaneIds.accountA);
  });

  it('keeps live state when key deletion fails and resumes after a transactional control-plane failure', async () => {
    const controlPlane = new D1IdentityVaultControlPlane(failureDatabase);
    const wrappedKeys = new D1VaultWrappedKeyFinalization(failureDatabase);
    const privateObjects = new D1VaultPrivateObjectDeletionBarrier(
      failureDatabase,
    );
    const input = {
      snapshot: finalizationRunningSnapshot(),
      executedAt: 1_500,
      privateObjects,
      wrappedKeys,
      controlPlane,
    } as const;
    await failureDatabase
      .prepare(
        `CREATE TRIGGER fail_wrapped_key_delete
         BEFORE DELETE ON vault_dek_versions
         WHEN OLD.vault_id = '${controlPlaneIds.vaultA}'
         BEGIN SELECT RAISE(ABORT, 'injected key deletion failure'); END`,
      )
      .run();
    await expect(executeFinalizeAccountStep(input)).resolves.toMatchObject({
      result: {
        kind: 'retryable-failure',
        failureCode: 'wrapped-key-finalization-unavailable',
      },
    });
    expect(await wrappedKeyCount(failureDatabase, controlPlaneIds.vaultA)).toBe(
      2,
    );
    expect(
      await controlStateCount(failureDatabase, controlPlaneIds.vaultA),
    ).toBe(4);
    await failureDatabase.prepare('DROP TRIGGER fail_wrapped_key_delete').run();

    await failureDatabase
      .prepare(
        `CREATE TRIGGER fail_identity_delete
         BEFORE DELETE ON identities
         WHEN OLD.account_id = '${controlPlaneIds.accountA}'
         BEGIN SELECT RAISE(ABORT, 'injected identity deletion failure'); END`,
      )
      .run();
    await expect(executeFinalizeAccountStep(input)).resolves.toMatchObject({
      result: {
        kind: 'retryable-failure',
        failureCode: 'account-live-state-unavailable',
      },
    });
    expect(await wrappedKeyCount(failureDatabase, controlPlaneIds.vaultA)).toBe(
      0,
    );
    expect(
      await controlStateCount(failureDatabase, controlPlaneIds.vaultA),
    ).toBe(4);
    await failureDatabase.prepare('DROP TRIGGER fail_identity_delete').run();

    await expect(executeFinalizeAccountStep(input)).resolves.toMatchObject({
      result: { kind: 'succeeded' },
    });
    expect(await ownerLiveCount(failureDatabase, controlPlaneIds.vaultA)).toBe(
      0,
    );
  });

  it('does not destroy wrapped keys while a private-object outbox row remains', async () => {
    const result = await executeFinalizeAccountStep({
      snapshot: finalizationRunningSnapshot(),
      executedAt: 1_500,
      privateObjects: new D1VaultPrivateObjectDeletionBarrier(outboxDatabase),
      wrappedKeys: new D1VaultWrappedKeyFinalization(outboxDatabase),
      controlPlane: new D1IdentityVaultControlPlane(outboxDatabase),
    });
    expect(result).toMatchObject({
      result: {
        kind: 'retryable-failure',
        failureCode: 'private-object-reconfirmation-incomplete',
      },
    });
    expect(await wrappedKeyCount(outboxDatabase, controlPlaneIds.vaultA)).toBe(
      2,
    );
    expect(
      await controlStateCount(outboxDatabase, controlPlaneIds.vaultA),
    ).toBe(4);
  });
});

async function seedTwoOwners(database: TestDatabase): Promise<void> {
  const controlPlane = new D1IdentityVaultControlPlane(database);
  for (const owner of ['a', 'b'] as const) {
    const provision = personalAccountProvision(owner);
    await controlPlane.provisionPersonalAccount(provision);
    if (owner === 'a') {
      await controlPlane.createSession({
        session: activeControlPlaneSession(),
        tokenHash: controlPlaneTokenHash,
      });
      await controlPlane.revokeAccountSessions({
        accountId: controlPlaneIds.accountA,
        vaultId: controlPlaneIds.vaultA,
        revokedAt: 1_100,
      });
    }
    const vaultId = provision.vault.vaultId;
    await database.batch([
      database
        .prepare(
          `INSERT INTO vault_dek_versions(
            vault_id, dek_version, kek_key_reference, wrapped_dek,
            is_write_key, created_at
          ) VALUES (?, ?, 'test-kek-v1', 'd3JhcHBlZC1kZWstdjE', 1, 1000)`,
        )
        .bind(vaultId, envelopeCryptoIds.dekVersion1),
      database
        .prepare(
          `INSERT INTO vault_dek_versions(
            vault_id, dek_version, kek_key_reference, wrapped_dek,
            is_write_key, created_at
          ) VALUES (?, ?, 'test-kek-v2', 'd3JhcHBlZC1kZWstdjI', 0, 1100)`,
        )
        .bind(vaultId, envelopeCryptoIds.dekVersion2),
    ]);
  }
}

async function enqueue(
  database: TestDatabase,
  vaultId: VaultId,
  objectKey: OpaqueObjectKey,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO vault_object_delete_outbox(
        vault_id, object_key, attempt_count, next_attempt_at, created_at
      ) VALUES (?, ?, 0, 1200, 1200)`,
    )
    .bind(vaultId, objectKey)
    .run();
}

async function ownerLiveCount(database: TestDatabase, vaultId: VaultId) {
  return (
    (await controlStateCount(database, vaultId)) +
    (await wrappedKeyCount(database, vaultId)) +
    (await tableCount(database, 'vault_object_delete_outbox', vaultId))
  );
}

async function controlStateCount(database: TestDatabase, vaultId: VaultId) {
  const raw: unknown = await database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM accounts account
         JOIN personal_vaults vault ON vault.account_id = account.account_id
         WHERE vault.vault_id = ?)
        + (SELECT COUNT(*) FROM personal_vaults WHERE vault_id = ?)
        + (SELECT COUNT(*) FROM identities identity
           JOIN personal_vaults vault ON vault.account_id = identity.account_id
           WHERE vault.vault_id = ?)
        + (SELECT COUNT(*) FROM sessions WHERE vault_id = ?) AS count`,
    )
    .bind(vaultId, vaultId, vaultId, vaultId)
    .first();
  return decodeOrThrow(countDecoder, raw, 'test control state count').count;
}

async function wrappedKeyCount(database: TestDatabase, vaultId: VaultId) {
  return tableCount(database, 'vault_dek_versions', vaultId);
}

async function tableCount(
  database: TestDatabase,
  table: 'vault_dek_versions' | 'vault_object_delete_outbox',
  vaultId: VaultId,
) {
  const raw: unknown = await database
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE vault_id = ?`)
    .bind(vaultId)
    .first();
  return decodeOrThrow(countDecoder, raw, `test ${table} count`).count;
}

async function ownerSnapshot(database: TestDatabase, vaultId: VaultId) {
  const raw: unknown = await database
    .prepare(
      `SELECT COALESCE(GROUP_CONCAT(row_value, char(10)), '') AS snapshot
       FROM (
         SELECT 'account|' || quote(account.account_id) || '|'
           || quote(account.created_at) AS row_value
         FROM accounts account JOIN personal_vaults vault
           ON vault.account_id = account.account_id WHERE vault.vault_id = ?
         UNION ALL
         SELECT 'vault|' || quote(account_id) || '|' || quote(created_at)
         FROM personal_vaults WHERE vault_id = ?
         UNION ALL
         SELECT 'identity|' || quote(identity_id) || '|' || quote(account_id)
           || '|' || quote(provider) || '|' || quote(issuer) || '|'
           || quote(subject) || '|' || quote(created_at)
         FROM identities WHERE account_id = (
           SELECT account_id FROM personal_vaults WHERE vault_id = ?
         )
         UNION ALL
         SELECT 'dek|' || quote(dek_version) || '|'
           || quote(kek_key_reference) || '|' || quote(wrapped_dek) || '|'
           || quote(is_write_key) || '|' || quote(created_at)
         FROM vault_dek_versions WHERE vault_id = ?
         ORDER BY row_value
       )`,
    )
    .bind(vaultId, vaultId, vaultId, vaultId)
    .first();
  return decodeOrThrow(snapshotDecoder, raw, 'test owner snapshot').snapshot;
}

function replacementProvision() {
  const accountId = parseAccountId('01991f20-61d2-7000-8000-000000001103');
  const vaultId = parseVaultId('01991f20-61d2-7000-8000-000000001203');
  return {
    account: { accountId, createdAt: 2_000 },
    vault: { vaultId, accountId, createdAt: 2_000 },
    identity: {
      identityId: parseIdentityId('01991f20-61d2-7000-8000-000000001303'),
      accountId,
      provider: 'google-oidc' as const,
      issuer: 'https://accounts.google.com',
      subject: 'google-subject-a',
      createdAt: 2_000,
    },
  };
}

function newOperation(): AccountDeletionOperation {
  return requireDeletionOperation(
    planAccountDeletionStart({
      operationId: accountDeletionFixtureIds.operationA,
      scope: {
        accountId: controlPlaneIds.accountA,
        vaultId: controlPlaneIds.vaultA,
      },
      requestedAt: 1_000,
    }),
  );
}

function claim(
  operation: AccountDeletionOperation,
  startedAt: number,
): AccountDeletionTransition {
  const plan = planAccountDeletionStepClaim({
    operation,
    startedAt,
    leaseExpiresAt: startedAt + 100,
  });
  if (plan.kind !== 'accepted') throw new Error('invalid claim fixture');
  return plan.transition;
}

function succeed(
  operation: AccountDeletionOperation,
  step: AccountDeletionStep,
  finishedAt: number,
): {
  readonly operation: AccountDeletionOperation;
  readonly receipt: AccountDeletionStepReceipt;
} {
  if (operation.state.kind !== 'running') {
    throw new Error('invalid running fixture');
  }
  const plan = planAccountDeletionStepResult({
    operation,
    result: {
      kind: 'succeeded',
      step,
      attempt: operation.state.attempt,
      finishedAt,
    },
    retryPolicy: { delaysMs: [100] },
  });
  if (plan.kind !== 'accepted' || plan.transition.receipt === undefined) {
    throw new Error('invalid success fixture');
  }
  return {
    operation: plan.transition.next,
    receipt: plan.transition.receipt,
  };
}

function finalizationRunningSnapshot(): AccountDeletionSnapshot {
  let operation = newOperation();
  const receipts: AccountDeletionStepReceipt[] = [];
  const steps = [
    'revoke-sessions',
    'cancel-subscription',
    'delete-vault-data',
    'delete-private-objects',
  ] as const;
  for (const [index, step] of steps.entries()) {
    const running = claim(operation, 1_000 + index * 100).next;
    const completed = succeed(running, step, 1_100 + index * 100);
    operation = completed.operation;
    receipts.push(completed.receipt);
  }
  return { operation: claim(operation, 1_400).next, receipts };
}
