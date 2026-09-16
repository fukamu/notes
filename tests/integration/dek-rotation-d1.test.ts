import { Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BoundaryDecodeError } from '@/lib/codec/core';
import {
  createFakeKeyManagement,
  FakeKeyManagementError,
} from '@/server/adapters/fake-key-management';
import { selectDekForRead, selectDekForWrite } from '@/server/crypto/core';
import { D1DekRotationRepository } from '@/server/crypto/rotation-d1-adapter';
import {
  parseDekRotationOperationId,
  planDekRotationGenerated,
  planDekRotationStart,
} from '@/server/crypto/rotation-core';
import { createDekRotationService } from '@/server/crypto/rotation-service';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { productionMigrationManifest } from '@/server/migrations/production';
import { controlPlaneIds } from '@/tests/fixtures/control-plane';
import {
  envelopeCryptoIds,
  envelopeDekMetadata,
  envelopeKeyBytes,
} from '@/tests/fixtures/envelope-crypto';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const operationA = parseDekRotationOperationId(
  '01991f20-61d2-7000-8000-000000001801',
);
const operationB = parseDekRotationOperationId(
  '01991f20-61d2-7000-8000-000000001802',
);
const scope = {
  accountId: controlPlaneIds.accountA,
  vaultId: controlPlaneIds.vaultA,
};

let miniflare: Miniflare;
let database: TestDatabase;
let repository: D1DekRotationRepository;

beforeEach(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['ROTATION'],
  });
  database = await miniflare.getD1Database('ROTATION');
  await runD1Migrations({
    database,
    manifest: productionMigrationManifest,
    appliedAt: 1_000,
  });
  repository = new D1DekRotationRepository(database);
  await seedVault(
    controlPlaneIds.accountA,
    controlPlaneIds.vaultA,
    envelopeDekMetadata(1),
  );
});

afterEach(async () => {
  await miniflare.dispose();
});

describe('D1 DEK rotation repository and service', () => {
  it('resumes generation and promotion and reloads a mixed-version keyring', async () => {
    const service = createDekRotationService({
      repository,
      keyManagement: keyManagement(),
    });
    const started = await service.start({
      scope,
      operationId: operationA,
      requestedAt: 1_500,
    });
    expect(started).toMatchObject({
      kind: 'pending',
      operation: { revision: 1, state: { kind: 'generating' } },
    });
    await expect(
      service.start({ scope, operationId: operationA, requestedAt: 1_600 }),
    ).resolves.toEqual(started);

    await expect(
      service.resume({ scope, operationId: operationA, performedAt: 2_000 }),
    ).resolves.toMatchObject({
      kind: 'pending',
      operation: { revision: 2, state: { kind: 'promoting' } },
    });
    const beforePromotion = await repository.load(scope);
    expect(beforePromotion).toMatchObject({
      kind: 'found',
      snapshot: {
        keyring: {
          writeVersion: envelopeCryptoIds.dekVersion1,
          versions: [{ dekVersion: envelopeCryptoIds.dekVersion1 }],
        },
      },
    });

    const completed = await service.resume({
      scope,
      operationId: operationA,
      performedAt: 2_100,
    });
    expect(completed).toMatchObject({
      kind: 'completed',
      operation: { revision: 3, state: { kind: 'completed' } },
    });
    const reloaded = await new D1DekRotationRepository(database).load(scope);
    if (reloaded.kind !== 'found') throw new Error('rotation snapshot missing');
    expect(reloaded.snapshot.keyring.writeVersion).toBe(
      envelopeCryptoIds.dekVersion2,
    );
    expect(
      reloaded.snapshot.keyring.versions.map((key) => key.dekVersion),
    ).toEqual([envelopeCryptoIds.dekVersion1, envelopeCryptoIds.dekVersion2]);
    expect(
      selectDekForRead(
        reloaded.snapshot.keyring,
        scope.vaultId,
        envelopeCryptoIds.dekVersion1,
      ).kind,
    ).toBe('selected');
    expect(
      selectDekForWrite(reloaded.snapshot.keyring, scope.vaultId),
    ).toMatchObject({
      kind: 'selected',
      metadata: { dekVersion: envelopeCryptoIds.dekVersion2 },
    });
    await expect(
      createDekRotationService({
        repository,
        keyManagement: keyManagement(),
      }).resume({
        scope,
        operationId: operationA,
        performedAt: 2_200,
      }),
    ).resolves.toEqual(completed);
    await expect(
      service.start({
        scope,
        operationId: operationB,
        requestedAt: 2_300,
      }),
    ).resolves.toMatchObject({
      kind: 'pending',
      operation: {
        sourceVersion: envelopeCryptoIds.dekVersion2,
        targetVersion: envelopeCryptoIds.dekVersion3,
        state: { kind: 'generating' },
      },
    });
  });

  it('keeps the durable generation checkpoint when KMS fails and resumes later', async () => {
    const failing = createDekRotationService({
      repository,
      keyManagement: keyManagement(true),
    });
    await failing.start({
      scope,
      operationId: operationA,
      requestedAt: 1_500,
    });
    await expect(
      failing.resume({ scope, operationId: operationA, performedAt: 2_000 }),
    ).rejects.toBeInstanceOf(FakeKeyManagementError);
    await expect(repository.load(scope)).resolves.toMatchObject({
      kind: 'found',
      snapshot: { operation: { revision: 1, state: { kind: 'generating' } } },
    });

    const recovered = createDekRotationService({
      repository: new D1DekRotationRepository(database),
      keyManagement: keyManagement(),
    });
    await expect(
      recovered.resume({
        scope,
        operationId: operationA,
        performedAt: 2_000,
      }),
    ).resolves.toMatchObject({
      kind: 'pending',
      operation: { revision: 2, state: { kind: 'promoting' } },
    });
  });

  it('replays a lost generated response and rejects a stale concurrent start', async () => {
    const loaded = await repository.load(scope);
    if (loaded.kind !== 'found') throw new Error('initial keyring missing');
    const startA = planDekRotationStart({
      scope,
      keyring: loaded.snapshot.keyring,
      operationId: operationA,
      requestedAt: 1_500,
    });
    const startB = planDekRotationStart({
      scope,
      keyring: loaded.snapshot.keyring,
      operationId: operationB,
      requestedAt: 1_500,
    });
    if (startA.kind !== 'accepted' || startB.kind !== 'accepted') {
      throw new Error('rotation plan rejected');
    }
    await expect(repository.start(scope, startA)).resolves.toMatchObject({
      kind: 'applied',
    });
    await expect(repository.start(scope, startB)).resolves.toMatchObject({
      kind: 'conflict',
      current: { operation: { operationId: operationA } },
    });

    const current = await repository.load(scope);
    if (current.kind !== 'found' || current.snapshot.operation === undefined) {
      throw new Error('rotation operation missing');
    }
    const generated = planDekRotationGenerated({
      operation: current.snapshot.operation,
      metadata: envelopeDekMetadata(2),
      generatedAt: 2_000,
    });
    if (generated.kind !== 'accepted') throw new Error('generation rejected');
    await expect(
      repository.recordGenerated(scope, generated.transition),
    ).resolves.toMatchObject({ kind: 'applied' });
    await expect(
      repository.recordGenerated(scope, generated.transition),
    ).resolves.toMatchObject({
      kind: 'replayed',
      snapshot: { operation: { revision: 2, state: { kind: 'promoting' } } },
    });
  });

  it('fails closed for cross-owner access and malformed wrapped metadata', async () => {
    const service = createDekRotationService({
      repository,
      keyManagement: keyManagement(),
    });
    await expect(
      service.start({
        scope: {
          accountId: controlPlaneIds.accountB,
          vaultId: controlPlaneIds.vaultA,
        },
        operationId: operationA,
        requestedAt: 1_500,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'not-found' });

    await service.start({ scope, operationId: operationA, requestedAt: 1_500 });
    await service.resume({
      scope,
      operationId: operationA,
      performedAt: 2_000,
    });
    await database
      .prepare(
        `UPDATE vault_dek_rotation_operations SET wrapped_dek = '!'
         WHERE account_id = ? AND vault_id = ?`,
      )
      .bind(scope.accountId, scope.vaultId)
      .run();
    await expect(repository.load(scope)).rejects.toBeInstanceOf(
      BoundaryDecodeError,
    );
  });
});

function keyManagement(failGenerate = false) {
  return createFakeKeyManagement({
    records: [
      {
        metadata: envelopeDekMetadata(1),
        keyBytes: envelopeKeyBytes.version1,
      },
      {
        metadata: envelopeDekMetadata(2),
        keyBytes: envelopeKeyBytes.version2,
      },
    ],
    ...(failGenerate ? { failGenerate: true } : {}),
  });
}

async function seedVault(
  accountId: string,
  vaultId: string,
  metadata: ReturnType<typeof envelopeDekMetadata>,
): Promise<void> {
  await database.batch([
    database
      .prepare('INSERT INTO accounts(account_id, created_at) VALUES (?, ?)')
      .bind(accountId, 1_000),
    database
      .prepare(
        'INSERT INTO personal_vaults(vault_id, account_id, created_at) VALUES (?, ?, ?)',
      )
      .bind(vaultId, accountId, 1_000),
    database
      .prepare(
        `INSERT INTO vault_dek_versions(
          vault_id, dek_version, kek_key_reference, wrapped_dek,
          is_write_key, created_at
        ) VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .bind(
        metadata.vaultId,
        metadata.dekVersion,
        metadata.kekKeyReference,
        metadata.wrappedDek,
        metadata.createdAt,
      ),
  ]);
}
