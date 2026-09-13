import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import type { VaultContext } from '@/lib/domain/identity';
import type { CardId, MutationId } from '@/lib/domain/id';
import {
  fixtureCardId,
  fixtureConflictId,
  fixtureMutationId,
} from '@/tests/fixtures/ids';
import { personalAccountProvision } from '@/tests/fixtures/control-plane';
import {
  vaultContentContext,
  vaultContentIds,
} from '@/tests/fixtures/vault-content';
import { parseSyncSequence } from '@/lib/sync/v2-protocol';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { D1VaultContentDirectory } from '@/server/vault-content/d1-adapter';
import { parseContentRevision } from '@/server/vault-content/records';
import { D1SyncV2JournalDirectory } from '@/server/vault-content/sync-v2-d1-adapter';
import {
  parseSyncV2MutationFingerprint,
  type SyncV2JournalCommit,
  type SyncV2JournalRepository,
} from '@/server/vault-content/sync-v2-public';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const ids = {
  cardA: fixtureCardId('sync-v2-d1-card-a'),
  cardB: fixtureCardId('sync-v2-d1-card-b'),
  conflict: fixtureConflictId('sync-v2-d1-conflict'),
  createA: fixtureMutationId('sync-v2-d1-create-a'),
  updateA: fixtureMutationId('sync-v2-d1-update-a'),
  conflictA: fixtureMutationId('sync-v2-d1-conflict-a'),
  resolveA: fixtureMutationId('sync-v2-d1-resolve-a'),
  createB: fixtureMutationId('sync-v2-d1-create-b'),
  deleteA: fixtureMutationId('sync-v2-d1-delete-a'),
  fingerprints: Array.from({ length: 6 }, (_, index) =>
    parseSyncV2MutationFingerprint(
      `${String.fromCharCode(97 + index).repeat(42)}A`,
    ),
  ),
  revision1: parseContentRevision(1),
  revision2: parseContentRevision(2),
  revision3: parseContentRevision(3),
  revision4: parseContentRevision(4),
} as const;

let miniflare: Miniflare;
let flowDatabase: TestDatabase;
let tenantDatabase: TestDatabase;
let failureDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['FLOW', 'TENANT', 'FAILURE'],
  });
  flowDatabase = await miniflare.getD1Database('FLOW');
  tenantDatabase = await miniflare.getD1Database('TENANT');
  failureDatabase = await miniflare.getD1Database('FAILURE');
  for (const database of [flowDatabase, tenantDatabase, failureDatabase]) {
    await runD1Migrations({
      database,
      manifest: productionMigrationManifest,
      appliedAt: 1_000,
    });
    await database.prepare('PRAGMA foreign_keys = ON').run();
  }
});

afterAll(async () => {
  await miniflare.dispose();
});

async function provision(
  database: TestDatabase,
  context: VaultContext,
  account: 'a' | 'b',
): Promise<SyncV2JournalRepository> {
  const controlPlane = new D1IdentityVaultControlPlane(database);
  await controlPlane.provisionPersonalAccount(
    personalAccountProvision(account),
  );
  const vaultContent = new D1VaultContentDirectory(database, controlPlane);
  await vaultContent.assignPartition(context, {
    partitionId: vaultContentIds.partitionHot,
    updatedAt: 1_000,
  });
  const opened = await new D1SyncV2JournalDirectory(
    database,
    vaultContent,
  ).open(context);
  if (opened.kind === 'not-found') throw new Error('expected Sync v2 journal');
  return opened.repository;
}

function fingerprint(index: number) {
  const value = ids.fingerprints[index];
  if (value === undefined) throw new Error('missing fingerprint fixture');
  return value;
}

function createCard(
  mutationId: MutationId,
  cardId: CardId,
  fingerprintIndex: number,
): SyncV2JournalCommit {
  return {
    kind: 'card-upsert',
    mutationId,
    fingerprint: fingerprint(fingerprintIndex),
    cardId,
    expectedRevision: null,
    nextRevision: ids.revision1,
    updatedAt: 1_100 + fingerprintIndex,
    committedAt: 1_200 + fingerprintIndex,
  };
}

describe('D1 Sync v2 journal repository', () => {
  it('commits, replays, resolves, deletes, and pages one fixed Vault snapshot', async () => {
    const repository = await provision(
      flowDatabase,
      vaultContentContext('a'),
      'a',
    );
    const createA = createCard(ids.createA, ids.cardA, 0);
    const created = await repository.commit(createA);
    expect(created).toMatchObject({
      kind: 'applied',
      receipt: { appliedRevision: ids.revision1 },
    });
    await expect(repository.commit(createA)).resolves.toEqual({
      ...created,
      kind: 'replayed',
    });
    await expect(
      repository.commit({ ...createA, fingerprint: fingerprint(5) }),
    ).resolves.toEqual({
      kind: 'not-applied',
      reason: 'idempotency-key-reuse',
    });
    expect(await repository.findCard(ids.cardA)).toEqual({
      cardId: ids.cardA,
      officialDisplayId: 1,
      revision: ids.revision1,
      updatedAt: 1_100,
    });

    await expect(
      repository.commit({
        kind: 'card-upsert',
        mutationId: ids.updateA,
        fingerprint: fingerprint(1),
        cardId: ids.cardA,
        expectedRevision: ids.revision1,
        nextRevision: ids.revision2,
        updatedAt: 1_300,
        committedAt: 1_300,
      }),
    ).resolves.toMatchObject({ kind: 'applied' });
    await expect(
      repository.commit({
        kind: 'conflict-upsert',
        mutationId: ids.conflictA,
        fingerprint: fingerprint(2),
        conflictId: ids.conflict,
        cardId: ids.cardA,
        serverRevision: ids.revision2,
        createdAt: 1_400,
        committedAt: 1_400,
      }),
    ).resolves.toMatchObject({ kind: 'applied' });
    await expect(
      repository.commit({
        kind: 'resolve-conflicts',
        mutationId: ids.resolveA,
        fingerprint: fingerprint(3),
        cardId: ids.cardA,
        expectedRevision: ids.revision2,
        nextRevision: ids.revision3,
        updatedAt: 1_500,
        committedAt: 1_500,
        conflictIds: [ids.conflict],
      }),
    ).resolves.toMatchObject({ kind: 'applied' });
    await expect(
      repository.commit(createCard(ids.createB, ids.cardB, 4)),
    ).resolves.toMatchObject({ kind: 'applied' });
    expect(await repository.findCard(ids.cardB)).toMatchObject({
      officialDisplayId: 2,
    });
    await expect(
      repository.commit({
        kind: 'card-delete',
        mutationId: ids.deleteA,
        fingerprint: fingerprint(5),
        cardId: ids.cardA,
        expectedRevision: ids.revision3,
        tombstoneRevision: ids.revision4,
        deletedAt: 1_600,
        committedAt: 1_600,
      }),
    ).resolves.toMatchObject({ kind: 'applied' });
    expect(await repository.findCard(ids.cardA)).toBeUndefined();
    expect(await repository.findReceipt(ids.deleteA)).toMatchObject({
      appliedRevision: ids.revision4,
    });

    const first = await repository.readPage({
      afterSequence: parseSyncSequence(0),
      highWatermark: null,
      limit: 2,
    });
    expect(first).toMatchObject({
      highWatermark: 7,
      changes: [
        { kind: 'card-upsert', sequence: 1, officialDisplayId: 1 },
        { kind: 'card-upsert', sequence: 2, revision: ids.revision2 },
      ],
      page: { kind: 'more', afterSequence: 2 },
    });
    const second = await repository.readPage({
      afterSequence: first.page.afterSequence,
      highWatermark: first.highWatermark,
      limit: 2,
    });
    expect(second.changes.map((change) => change.kind)).toEqual([
      'conflict-upsert',
      'card-upsert',
    ]);
    const third = await repository.readPage({
      afterSequence: second.page.afterSequence,
      highWatermark: first.highWatermark,
      limit: 2,
    });
    expect(third.changes.map((change) => change.kind)).toEqual([
      'conflict-tombstone',
      'card-upsert',
    ]);
    const finalPage = await repository.readPage({
      afterSequence: third.page.afterSequence,
      highWatermark: first.highWatermark,
      limit: 2,
    });
    expect(finalPage).toMatchObject({
      changes: [{ kind: 'card-tombstone', sequence: 7 }],
      page: { kind: 'complete', afterSequence: 7 },
    });
    await expect(
      repository.readPage({
        afterSequence: finalPage.page.afterSequence,
        highWatermark: finalPage.highWatermark,
        limit: 2,
      }),
    ).resolves.toEqual({
      highWatermark: parseSyncSequence(7),
      changes: [],
      page: { kind: 'complete', afterSequence: parseSyncSequence(7) },
    });
  });

  it('isolates identical identifiers across Vaults and rejects a stale route', async () => {
    const contextA = vaultContentContext('a');
    const contextB = vaultContentContext('b');
    const repositoryA = await provision(tenantDatabase, contextA, 'a');
    const repositoryB = await provision(tenantDatabase, contextB, 'b');
    const command = createCard(ids.createA, ids.cardA, 0);
    await expect(repositoryA.commit(command)).resolves.toMatchObject({
      kind: 'applied',
    });
    await expect(repositoryB.commit(command)).resolves.toMatchObject({
      kind: 'applied',
    });
    for (const repository of [repositoryA, repositoryB]) {
      await expect(
        repository.readPage({
          afterSequence: parseSyncSequence(0),
          highWatermark: null,
          limit: 10,
        }),
      ).resolves.toMatchObject({
        highWatermark: 1,
        changes: [{ cardId: ids.cardA, officialDisplayId: 1 }],
      });
    }

    const controlPlane = new D1IdentityVaultControlPlane(tenantDatabase);
    const content = new D1VaultContentDirectory(tenantDatabase, controlPlane);
    await expect(
      content.compareAndSwapPartition(contextA, {
        expectedRoutingRevision: vaultContentIds.routingRevision1,
        nextPartitionId: vaultContentIds.partitionRemapped,
        updatedAt: 2_000,
      }),
    ).resolves.toMatchObject({ kind: 'applied' });
    await expect(
      repositoryA.readPage({
        afterSequence: parseSyncSequence(0),
        highWatermark: null,
        limit: 10,
      }),
    ).rejects.toBeInstanceOf(BoundaryDecodeError);
    const mismatched = await new D1SyncV2JournalDirectory(
      tenantDatabase,
      content,
    ).open({ ...contextA, vaultId: contextB.vaultId });
    expect(mismatched).toEqual({ kind: 'not-found' });
  });

  it('rolls back every metadata write when a journal insert fails', async () => {
    const repository = await provision(
      failureDatabase,
      vaultContentContext('a'),
      'a',
    );
    await failureDatabase
      .prepare(
        `CREATE TRIGGER fail_sync_v2_change
         BEFORE INSERT ON vault_sync_v2_changes
         BEGIN SELECT RAISE(ABORT, 'injected journal failure'); END`,
      )
      .run();
    const command = createCard(ids.createA, ids.cardA, 0);
    await expect(repository.commit(command)).rejects.toThrow(
      'injected journal failure',
    );
    expect(await repository.findCard(ids.cardA)).toBeUndefined();
    expect(await repository.findReceipt(ids.createA)).toBeUndefined();
    await expect(
      repository.readPage({
        afterSequence: parseSyncSequence(0),
        highWatermark: null,
        limit: 10,
      }),
    ).resolves.toMatchObject({ highWatermark: 0, changes: [] });
    await failureDatabase.prepare('DROP TRIGGER fail_sync_v2_change').run();
    await expect(repository.commit(command)).resolves.toMatchObject({
      kind: 'applied',
    });
  });
});
