import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import type { VaultContext } from '@/lib/domain/identity';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { D1VaultContentDirectory } from '@/server/vault-content/d1-adapter';
import type {
  VaultContentDirectory,
  VaultContentRepository,
} from '@/server/vault-content/public';
import { personalAccountProvision } from '@/tests/fixtures/control-plane';
import {
  vaultContentContext,
  vaultContentIds,
} from '@/tests/fixtures/vault-content';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

let miniflare: Miniflare;
let tenantDatabase: TestDatabase;
let malformedDatabase: TestDatabase;

async function openRepository(
  directory: VaultContentDirectory,
  context: VaultContext,
): Promise<VaultContentRepository> {
  const result = await directory.open(context);
  if (result.kind === 'not-found') throw new Error('expected an opened Vault');
  return result.repository;
}

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['TENANT', 'MALFORMED'],
  });
  tenantDatabase = await miniflare.getD1Database('TENANT');
  malformedDatabase = await miniflare.getD1Database('MALFORMED');
  for (const database of [tenantDatabase, malformedDatabase]) {
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

describe('D1 Vault-scoped content repository', () => {
  it('isolates identical card, mutation, and conflict IDs on a shared hot partition', async () => {
    const controlPlane = new D1IdentityVaultControlPlane(tenantDatabase);
    await controlPlane.provisionPersonalAccount(personalAccountProvision('a'));
    await controlPlane.provisionPersonalAccount(personalAccountProvision('b'));
    const directory = new D1VaultContentDirectory(tenantDatabase, controlPlane);
    const contextA = vaultContentContext('a');
    const contextB = vaultContentContext('b');
    for (const context of [contextA, contextB]) {
      expect(
        await directory.assignPartition(context, {
          partitionId: vaultContentIds.partitionHot,
          updatedAt: 1_000,
        }),
      ).toMatchObject({ kind: 'applied' });
    }

    expect(
      await directory.open({
        ...contextA,
        vaultId: contextB.vaultId,
      }),
    ).toEqual({ kind: 'not-found' });
    expect(
      await directory.assignPartition(
        { ...contextB, accountId: contextA.accountId },
        { partitionId: vaultContentIds.partitionHot, updatedAt: 1_000 },
      ),
    ).toEqual({ kind: 'not-applied' });

    const repositoryA = await openRepository(directory, contextA);
    const repositoryB = await openRepository(directory, contextB);
    const cardCreate = {
      cardId: vaultContentIds.card,
      expectedRevision: null,
      nextRevision: vaultContentIds.revision1,
      updatedAt: 1_000,
    } as const;
    expect(await repositoryA.compareAndSwapCard(cardCreate)).toEqual({
      kind: 'applied',
    });
    expect(await repositoryB.compareAndSwapCard(cardCreate)).toEqual({
      kind: 'applied',
    });

    const receipt = {
      mutationId: vaultContentIds.mutation,
      cardId: vaultContentIds.card,
      appliedRevision: vaultContentIds.revision1,
      createdAt: 1_100,
    };
    const conflict = {
      conflictId: vaultContentIds.conflict,
      cardId: vaultContentIds.card,
      serverRevision: vaultContentIds.revision1,
      createdAt: 1_200,
    };
    for (const repository of [repositoryA, repositoryB]) {
      expect(await repository.recordMutationReceipt(receipt)).toEqual({
        kind: 'applied',
      });
      expect(await repository.recordConflict(conflict)).toEqual({
        kind: 'applied',
      });
      expect(await repository.listCards()).toEqual([
        {
          cardId: vaultContentIds.card,
          revision: vaultContentIds.revision1,
          updatedAt: 1_000,
        },
      ]);
    }
    expect(await repositoryA.findMutationReceipt(receipt.mutationId)).toEqual(
      receipt,
    );
    expect(await repositoryB.findMutationReceipt(receipt.mutationId)).toEqual(
      receipt,
    );
    expect(await repositoryA.findConflict(conflict.conflictId)).toEqual(
      conflict,
    );
    expect(await repositoryB.findConflict(conflict.conflictId)).toEqual(
      conflict,
    );

    expect(
      await repositoryB.deleteConflict(
        conflict.conflictId,
        conflict.serverRevision,
      ),
    ).toEqual({ kind: 'applied' });
    expect(await repositoryB.findConflict(conflict.conflictId)).toBeUndefined();
    expect(await repositoryA.findConflict(conflict.conflictId)).toEqual(
      conflict,
    );
    expect(
      await repositoryB.deleteCard(
        vaultContentIds.card,
        vaultContentIds.revision1,
      ),
    ).toEqual({ kind: 'applied' });
    expect(await repositoryB.findCard(vaultContentIds.card)).toBeUndefined();
    expect(await repositoryA.findCard(vaultContentIds.card)).toEqual({
      cardId: vaultContentIds.card,
      revision: vaultContentIds.revision1,
      updatedAt: 1_000,
    });
  });

  it('invalidates a stale repository after partition remap CAS', async () => {
    const controlPlane = new D1IdentityVaultControlPlane(tenantDatabase);
    const directory = new D1VaultContentDirectory(tenantDatabase, controlPlane);
    const context = vaultContentContext('a');
    const staleRepository = await openRepository(directory, context);
    expect(
      await directory.compareAndSwapPartition(context, {
        expectedRoutingRevision: vaultContentIds.routingRevision1,
        nextPartitionId: vaultContentIds.partitionRemapped,
        updatedAt: 2_000,
      }),
    ).toEqual({
      kind: 'applied',
      route: {
        partitionId: vaultContentIds.partitionRemapped,
        routingRevision: vaultContentIds.routingRevision2,
        updatedAt: 2_000,
      },
    });
    expect(
      await directory.compareAndSwapPartition(context, {
        expectedRoutingRevision: vaultContentIds.routingRevision1,
        nextPartitionId: vaultContentIds.partitionHot,
        updatedAt: 3_000,
      }),
    ).toEqual({ kind: 'not-applied' });
    expect(
      await staleRepository.compareAndSwapCard({
        cardId: vaultContentIds.card,
        expectedRevision: vaultContentIds.revision1,
        nextRevision: vaultContentIds.revision2,
        updatedAt: 2_000,
      }),
    ).toEqual({ kind: 'not-applied' });

    const currentRepository = await openRepository(directory, context);
    expect(
      await currentRepository.compareAndSwapCard({
        cardId: vaultContentIds.card,
        expectedRevision: vaultContentIds.revision1,
        nextRevision: vaultContentIds.revision2,
        updatedAt: 2_000,
      }),
    ).toEqual({ kind: 'applied' });
  });

  it('decodes route rows from unknown and rejects malformed or corrupt ownership', async () => {
    const controlPlane = new D1IdentityVaultControlPlane(malformedDatabase);
    await controlPlane.provisionPersonalAccount(personalAccountProvision('a'));
    await controlPlane.provisionPersonalAccount(personalAccountProvision('b'));
    const directory = new D1VaultContentDirectory(
      malformedDatabase,
      controlPlane,
    );
    const contextA = vaultContentContext('a');
    await directory.assignPartition(contextA, {
      partitionId: vaultContentIds.partitionHot,
      updatedAt: 1_000,
    });
    await malformedDatabase
      .prepare("UPDATE vault_partition_mappings SET partition_id = 'INVALID!'")
      .run();
    await expect(directory.open(contextA)).rejects.toBeInstanceOf(
      BoundaryDecodeError,
    );

    await malformedDatabase
      .prepare(
        'UPDATE vault_partition_mappings SET partition_id = ?, account_id = ?',
      )
      .bind(vaultContentIds.partitionHot, vaultContentContext('b').accountId)
      .run();
    expect(
      await directory.open({
        ...vaultContentContext('b'),
        vaultId: contextA.vaultId,
      }),
    ).toEqual({ kind: 'not-found' });
  });
});
