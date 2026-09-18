import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeOrThrow,
  objectDecoder,
  safeIntegerDecoder,
  stringDecoder,
} from '@/lib/codec/core';
import type { VaultId } from '@/lib/domain/identity';
import { createFakePrivateObjectStorage } from '@/server/adapters/fake-private-object-storage';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { D1VaultObjectDeleteOutboxDirectory } from '@/server/encrypted-object/d1-adapter';
import { createVaultPrivateObjectPurge } from '@/server/encrypted-object/delete-vault-objects';
import type { OpaqueObjectKey } from '@/server/encrypted-object/core';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import {
  controlPlaneIds,
  personalAccountProvision,
} from '@/tests/fixtures/control-plane';
import { envelopeCryptoIds } from '@/tests/fixtures/envelope-crypto';
import { encryptedObjectIds } from '@/tests/fixtures/encrypted-object';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const countDecoder = objectDecoder(
  { count: safeIntegerDecoder({ minimum: 0 }) },
  { unknownFields: 'allow' },
);
const outboxRowDecoder = objectDecoder(
  {
    keys: stringDecoder({ maxLength: 10_000 }),
    attempts: stringDecoder({ maxLength: 10_000 }),
    next_attempts: stringDecoder({ maxLength: 10_000 }),
  },
  { unknownFields: 'allow' },
);

let miniflare: Miniflare;
let successDatabase: TestDatabase;
let failureDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['SUCCESS', 'FAILURE'],
  });
  successDatabase = await miniflare.getD1Database('SUCCESS');
  failureDatabase = await miniflare.getD1Database('FAILURE');
  for (const database of [successDatabase, failureDatabase]) {
    await runD1Migrations({
      database,
      manifest: productionMigrationManifest,
      appliedAt: 1_000,
    });
    await database.prepare('PRAGMA foreign_keys = ON').run();
    await seedOwners(database);
  }
  await seedOutbox(successDatabase, controlPlaneIds.vaultA, [
    encryptedObjectIds.objectKeyA,
    encryptedObjectIds.objectKeyB,
  ]);
  await seedOutbox(successDatabase, controlPlaneIds.vaultB, [
    encryptedObjectIds.objectKeyA,
    encryptedObjectIds.objectKeyB,
  ]);
  await seedOutbox(failureDatabase, controlPlaneIds.vaultA, [
    encryptedObjectIds.objectKeyA,
    encryptedObjectIds.objectKeyB,
    encryptedObjectIds.objectKeyC,
  ]);
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('account deletion private object purge', () => {
  it('deletes only the scoped outbox batch, accepts not-found, and makes empty resume a no-op', async () => {
    const objectsA = createFakePrivateObjectStorage([
      storedObject(encryptedObjectIds.objectKeyA),
    ]);
    const objectsB = createFakePrivateObjectStorage([
      storedObject(encryptedObjectIds.objectKeyA),
      storedObject(encryptedObjectIds.objectKeyB),
    ]);
    const purgeA = purgeService(successDatabase, objectsA, 1);
    const beforeB = await outboxSnapshot(
      successDatabase,
      controlPlaneIds.vaultB,
    );
    const outboxes = new D1VaultObjectDeleteOutboxDirectory(
      successDatabase,
      new D1IdentityVaultControlPlane(successDatabase),
    );
    await expect(
      outboxes.open({
        accountId: controlPlaneIds.accountA,
        vaultId: controlPlaneIds.vaultB,
      }),
    ).resolves.toEqual({ kind: 'owner-mismatch' });

    await expect(
      purgeA.purgeVaultPrivateObjects({
        scope: {
          accountId: controlPlaneIds.accountA,
          vaultId: controlPlaneIds.vaultB,
        },
        attemptedAt: 1_200,
      }),
    ).resolves.toEqual({
      kind: 'terminal-failure',
      reason: 'owner-mismatch',
    });
    expect(objectsA.calls().delete).toBe(0);
    expect(
      await outboxSnapshot(successDatabase, controlPlaneIds.vaultB),
    ).toEqual(beforeB);

    await expect(
      purgeA.purgeVaultPrivateObjects({
        scope: ownerScope('a'),
        attemptedAt: 1_200,
      }),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'objects-remaining',
    });
    expect(await outboxCount(successDatabase, controlPlaneIds.vaultA)).toBe(1);
    expect(objectsA.calls().delete).toBe(1);

    await expect(
      purgeA.purgeVaultPrivateObjects({
        scope: ownerScope('a'),
        attemptedAt: 1_200,
      }),
    ).resolves.toEqual({ kind: 'confirmed', outcome: 'deleted' });
    expect(await outboxCount(successDatabase, controlPlaneIds.vaultA)).toBe(0);
    expect(objectsA.calls().delete).toBe(2);
    expect(await objectsA.get(encryptedObjectIds.objectKeyA)).toBeUndefined();
    expect(
      await outboxSnapshot(successDatabase, controlPlaneIds.vaultB),
    ).toEqual(beforeB);
    expect(objectsB.calls().delete).toBe(0);

    await expect(
      purgeA.purgeVaultPrivateObjects({
        scope: ownerScope('a'),
        attemptedAt: 1_300,
      }),
    ).resolves.toEqual({ kind: 'confirmed', outcome: 'already-empty' });
    expect(objectsA.calls().delete).toBe(2);
    expect(
      await ownerAndDekCount(successDatabase, controlPlaneIds.vaultA),
    ).toBe(2);
  });

  it('keeps only failed rows for retry and recovers after lost D1 confirmation', async () => {
    const objects = createFakePrivateObjectStorage([
      storedObject(encryptedObjectIds.objectKeyA),
      storedObject(encryptedObjectIds.objectKeyB),
      storedObject(encryptedObjectIds.objectKeyC),
    ]);
    objects.failDeleteForTest(encryptedObjectIds.objectKeyB);
    const purge = purgeService(failureDatabase, objects, 3);

    await expect(
      purge.purgeVaultPrivateObjects({
        scope: ownerScope('a'),
        attemptedAt: 2_000,
      }),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'storage-unavailable',
    });
    await expect(
      outboxSnapshot(failureDatabase, controlPlaneIds.vaultA),
    ).resolves.toEqual({
      keys: encryptedObjectIds.objectKeyB,
      attempts: '1',
      next_attempts: '2100',
    });
    expect(await objects.get(encryptedObjectIds.objectKeyA)).toBeUndefined();
    expect(await objects.get(encryptedObjectIds.objectKeyB)).toBeDefined();
    expect(await objects.get(encryptedObjectIds.objectKeyC)).toBeUndefined();

    const callsBeforeBackoff = objects.calls().delete;
    await expect(
      purge.purgeVaultPrivateObjects({
        scope: ownerScope('a'),
        attemptedAt: 2_099,
      }),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'objects-remaining',
    });
    expect(objects.calls().delete).toBe(callsBeforeBackoff);
    await expect(
      purge.purgeVaultPrivateObjects({
        scope: ownerScope('a'),
        attemptedAt: 2_100,
      }),
    ).resolves.toEqual({ kind: 'confirmed', outcome: 'deleted' });

    await enqueue(
      failureDatabase,
      controlPlaneIds.vaultA,
      encryptedObjectIds.objectKeyD,
      2_200,
    );
    await objects.putIfAbsent({
      ...storedObject(encryptedObjectIds.objectKeyD),
      createdAt: 2_200,
    });
    await failureDatabase
      .prepare(
        `CREATE TRIGGER fail_object_delete_confirmation
         BEFORE DELETE ON vault_object_delete_outbox
         WHEN OLD.vault_id = '${controlPlaneIds.vaultA}'
           AND OLD.object_key = '${encryptedObjectIds.objectKeyD}'
         BEGIN SELECT RAISE(ABORT, 'injected confirmation failure'); END`,
      )
      .run();
    await expect(
      purge.purgeVaultPrivateObjects({
        scope: ownerScope('a'),
        attemptedAt: 2_200,
      }),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'delete-confirmation-unavailable',
    });
    expect(await objects.get(encryptedObjectIds.objectKeyD)).toBeUndefined();
    expect(await outboxCount(failureDatabase, controlPlaneIds.vaultA)).toBe(1);

    await failureDatabase
      .prepare('DROP TRIGGER fail_object_delete_confirmation')
      .run();
    await expect(
      purge.purgeVaultPrivateObjects({
        scope: ownerScope('a'),
        attemptedAt: 2_300,
      }),
    ).resolves.toEqual({ kind: 'confirmed', outcome: 'deleted' });
    expect(await outboxCount(failureDatabase, controlPlaneIds.vaultA)).toBe(0);
  });
});

function purgeService(
  database: TestDatabase,
  objects: ReturnType<typeof createFakePrivateObjectStorage>,
  batchLimit: number,
) {
  const controlPlane = new D1IdentityVaultControlPlane(database);
  return createVaultPrivateObjectPurge({
    scope: ownerScope('a'),
    outboxes: new D1VaultObjectDeleteOutboxDirectory(database, controlPlane),
    objects,
    policy: { batchLimit, retryDelayMs: 100 },
  });
}

function ownerScope(owner: 'a' | 'b') {
  return owner === 'a'
    ? {
        accountId: controlPlaneIds.accountA,
        vaultId: controlPlaneIds.vaultA,
      }
    : {
        accountId: controlPlaneIds.accountB,
        vaultId: controlPlaneIds.vaultB,
      };
}

function storedObject(objectKey: OpaqueObjectKey) {
  return {
    objectKey,
    bytes: new Uint8Array([1, 2, 3]),
    createdAt: 1_000,
  };
}

async function seedOwners(database: TestDatabase): Promise<void> {
  const controlPlane = new D1IdentityVaultControlPlane(database);
  await controlPlane.provisionPersonalAccount(personalAccountProvision('a'));
  await controlPlane.provisionPersonalAccount(personalAccountProvision('b'));
  for (const vaultId of [controlPlaneIds.vaultA, controlPlaneIds.vaultB]) {
    await database
      .prepare(
        `INSERT INTO vault_dek_versions(
          vault_id, dek_version, kek_key_reference, wrapped_dek,
          is_write_key, created_at
        ) VALUES (?, ?, 'test-kek', 'wrapped-test-dek', 1, 1000)`,
      )
      .bind(vaultId, envelopeCryptoIds.dekVersion1)
      .run();
  }
}

async function seedOutbox(
  database: TestDatabase,
  vaultId: VaultId,
  objectKeys: readonly OpaqueObjectKey[],
): Promise<void> {
  for (const objectKey of objectKeys) {
    await enqueue(database, vaultId, objectKey, 1_100);
  }
}

async function enqueue(
  database: TestDatabase,
  vaultId: VaultId,
  objectKey: OpaqueObjectKey,
  createdAt: number,
): Promise<void> {
  await database
    .prepare(
      `INSERT INTO vault_object_delete_outbox(
        vault_id, object_key, attempt_count, next_attempt_at, created_at
      ) VALUES (?, ?, 0, ?, ?)`,
    )
    .bind(vaultId, objectKey, createdAt, createdAt)
    .run();
}

async function outboxCount(database: TestDatabase, vaultId: VaultId) {
  const raw: unknown = await database
    .prepare(
      'SELECT COUNT(*) AS count FROM vault_object_delete_outbox WHERE vault_id = ?',
    )
    .bind(vaultId)
    .first();
  return decodeOrThrow(countDecoder, raw, 'test delete outbox count').count;
}

async function outboxSnapshot(database: TestDatabase, vaultId: VaultId) {
  const raw: unknown = await database
    .prepare(
      `SELECT
        COALESCE(GROUP_CONCAT(object_key, ','), '') AS keys,
        COALESCE(GROUP_CONCAT(attempt_count, ','), '') AS attempts,
        COALESCE(GROUP_CONCAT(next_attempt_at, ','), '') AS next_attempts
       FROM (
         SELECT object_key, attempt_count, next_attempt_at
         FROM vault_object_delete_outbox
         WHERE vault_id = ? ORDER BY object_key
       )`,
    )
    .bind(vaultId)
    .first();
  return decodeOrThrow(outboxRowDecoder, raw, 'test delete outbox snapshot');
}

async function ownerAndDekCount(database: TestDatabase, vaultId: VaultId) {
  const raw: unknown = await database
    .prepare(
      `SELECT
        (SELECT COUNT(*) FROM personal_vaults WHERE vault_id = ?)
        + (SELECT COUNT(*) FROM vault_dek_versions WHERE vault_id = ?) AS count`,
    )
    .bind(vaultId, vaultId)
    .first();
  return decodeOrThrow(countDecoder, raw, 'test preserved owner/DEK count')
    .count;
}
