import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { VaultContext } from '@/lib/domain/identity';
import type { EnvelopeObject, VaultDekKeyring } from '@/server/crypto/core';
import { decodeVaultDekKeyring } from '@/server/crypto/core';
import {
  createEnvelopeEncryptionService,
  type EnvelopeEncryptionService,
} from '@/server/crypto/envelope-service';
import { webCryptoAes256Gcm } from '@/server/crypto/web-aes-gcm';
import { createFakeKeyManagement } from '@/server/adapters/fake-key-management';
import {
  FakePrivateObjectStorageError,
  createFakePrivateObjectStorage,
} from '@/server/adapters/fake-private-object-storage';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { D1EncryptedObjectMetadataDirectory } from '@/server/encrypted-object/d1-adapter';
import { D1EncryptedObjectReencryptionDirectory } from '@/server/encrypted-object/reencryption-d1-adapter';
import {
  createEncryptedObjectReencryptionService,
  EncryptedObjectReencryptionIntegrityError,
} from '@/server/encrypted-object/reencryption-service';
import type {
  EncryptedObjectMetadataRepository,
  OpaqueObjectKeyGeneratorPort,
} from '@/server/encrypted-object/ports';
import { createEncryptedObjectService } from '@/server/encrypted-object/service';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { D1VaultContentDirectory } from '@/server/vault-content/d1-adapter';
import {
  controlPlaneIds,
  personalAccountProvision,
} from '@/tests/fixtures/control-plane';
import {
  envelopeCryptoIds,
  envelopeDekMetadata,
  envelopeKeyBytes,
} from '@/tests/fixtures/envelope-crypto';
import { encryptedObjectIds } from '@/tests/fixtures/encrypted-object';
import {
  vaultContentContext,
  vaultContentIds,
} from '@/tests/fixtures/vault-content';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

// This composite suite provisions three isolated D1 databases and performs real
// Web Crypto. The repository uses the same ceiling for other composite D1
// suites; this is a completion guard, not a production performance threshold.
vi.setConfig({ testTimeout: 15_000 });

let miniflare: Miniflare;
let happyDatabase: TestDatabase;
let failureDatabase: TestDatabase;
let casDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['HAPPY', 'FAILURE', 'CAS'],
  });
  happyDatabase = await miniflare.getD1Database('HAPPY');
  failureDatabase = await miniflare.getD1Database('FAILURE');
  casDatabase = await miniflare.getD1Database('CAS');
  for (const database of [happyDatabase, failureDatabase, casDatabase]) {
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

describe('encrypted object re-encryption', () => {
  it('resumes across page boundaries, isolates Vaults and does no crypto or object work when complete', async () => {
    const contextA = vaultContentContext('a');
    const contextB = vaultContentContext('b');
    const scopeA = await openRepositories(happyDatabase, contextA);
    const scopeB = await openRepositories(happyDatabase, contextB);
    const objects = createFakePrivateObjectStorage();
    const writerA = createEncryptedObjectService({
      context: contextA,
      metadata: scopeA.metadata,
      objects,
      objectKeys: objectKeys([
        encryptedObjectIds.objectKeyA,
        encryptedObjectIds.objectKeyB,
      ]).port,
      encryption: encryptionFor(contextA),
    });
    const writerB = createEncryptedObjectService({
      context: contextB,
      metadata: scopeB.metadata,
      objects,
      objectKeys: objectKeys([encryptedObjectIds.objectKeyC]).port,
      encryption: encryptionFor(contextB),
    });
    await expect(
      writerA.write(writeCommand(contextA, 'a')),
    ).resolves.toMatchObject({ kind: 'stored' });
    await expect(
      writerA.write(writeCommand(contextA, 'b')),
    ).resolves.toMatchObject({ kind: 'stored' });
    await expect(
      writerB.write(writeCommand(contextB, 'a')),
    ).resolves.toMatchObject({ kind: 'stored' });

    const encryption = countedEncryption(encryptionFor(contextA));
    const keys = objectKeys([
      encryptedObjectIds.objectKeyD,
      encryptedObjectIds.objectKeyE,
    ]);
    const service = createEncryptedObjectReencryptionService({
      context: contextA,
      repository: scopeA.reencryption,
      objects,
      objectKeys: keys.port,
      encryption: encryption.port,
    });
    const first = await service.runBatch({
      keyring: keyringFor(contextA, 2),
      limit: 1,
      performedAt: 3_000,
    });
    expect(first).toMatchObject({
      kind: 'pending',
      processed: 1,
      reason: 'page-limit',
    });
    if (first.kind !== 'pending') throw new Error('missing checkpoint');
    await expect(
      service.runBatch({
        keyring: keyringFor(contextA, 2),
        checkpoint: first.checkpoint,
        limit: 1,
        performedAt: 3_001,
      }),
    ).resolves.toEqual({ kind: 'completed', processed: 1 });

    const metadataA = await scopeA.metadata.findRevision(
      writeCommand(contextA, 'a').object,
      envelopeCryptoIds.objectRevision1,
    );
    expect(metadataA).toMatchObject({
      objectRevision: envelopeCryptoIds.objectRevision1,
      writeId: encryptedObjectIds.writeA,
      objectKey: encryptedObjectIds.objectKeyD,
      dekVersion: envelopeCryptoIds.dekVersion2,
      createdAt: 1_000,
    });
    await expect(
      writerA.read({
        object: writeCommand(contextA, 'a').object,
        keyring: keyringFor(contextA, 2),
      }),
    ).resolves.toEqual({
      kind: 'found',
      plaintext: writeCommand(contextA, 'a').plaintext,
    });
    await expect(
      scopeA.metadata.listReadyDeletes({ now: 3_001, limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({ objectKey: encryptedObjectIds.objectKeyA }),
      expect.objectContaining({ objectKey: encryptedObjectIds.objectKeyB }),
    ]);
    await expect(
      scopeB.reencryption.inventory(envelopeCryptoIds.dekVersion2),
    ).resolves.toMatchObject({ olderObjects: 1, targetObjects: 0 });
    await expect(
      scopeB.metadata.findRevision(
        writeCommand(contextB, 'a').object,
        envelopeCryptoIds.objectRevision1,
      ),
    ).resolves.toMatchObject({
      objectKey: encryptedObjectIds.objectKeyC,
      dekVersion: envelopeCryptoIds.dekVersion1,
    });

    const objectCalls = objects.calls();
    const cryptoCalls = encryption.calls();
    const keyCalls = keys.calls();
    await expect(
      service.runBatch({
        keyring: keyringFor(contextA, 2),
        limit: 10,
        performedAt: 4_000,
      }),
    ).resolves.toEqual({ kind: 'completed', processed: 0 });
    expect(objects.calls()).toEqual(objectCalls);
    expect(encryption.calls()).toEqual(cryptoCalls);
    expect(keys.calls()).toBe(keyCalls);

    if (metadataA === undefined) throw new Error('missing metadata');
    await expect(
      scopeA.metadata.reserveIntent({
        object: metadataA.object,
        expectedRevision: envelopeCryptoIds.objectRevision1,
        objectRevision: envelopeCryptoIds.objectRevision2,
        writeId: encryptedObjectIds.writeC,
        objectKey: encryptedObjectIds.objectKeyF,
        plaintextBytes: metadataA.plaintextBytes,
        cryptoVersion: metadataA.cryptoVersion,
        dekVersion: envelopeCryptoIds.dekVersion1,
        createdAt: 4_001,
      }),
    ).resolves.toMatchObject({ kind: 'reserved' });
    await expect(
      service.runBatch({
        keyring: keyringFor(contextA, 2),
        limit: 10,
        performedAt: 4_001,
      }),
    ).resolves.toMatchObject({
      kind: 'pending',
      processed: 0,
      reason: 'pending-writes',
    });
    expect(objects.calls()).toEqual(objectCalls);
    expect(encryption.calls()).toEqual(cryptoCalls);
    expect(keys.calls()).toBe(keyCalls);
  });

  it('fails closed on R2/KMS failure and authenticated ciphertext swaps', async () => {
    const context = vaultContentContext('a');
    const scope = await openRepositories(failureDatabase, context);
    const objects = createFakePrivateObjectStorage();
    const writer = createEncryptedObjectService({
      context,
      metadata: scope.metadata,
      objects,
      objectKeys: objectKeys([
        encryptedObjectIds.objectKeyA,
        encryptedObjectIds.objectKeyB,
      ]).port,
      encryption: encryptionFor(context),
    });
    await writer.write(writeCommand(context, 'a'));
    await writer.write(writeCommand(context, 'b'));
    const originalA = await objects.get(encryptedObjectIds.objectKeyA);
    const ciphertextB = await objects.get(encryptedObjectIds.objectKeyB);
    if (originalA === undefined || ciphertextB === undefined) {
      throw new Error('missing ciphertext fixture');
    }
    const keys = objectKeys([
      encryptedObjectIds.objectKeyD,
      encryptedObjectIds.objectKeyE,
      encryptedObjectIds.objectKeyF,
    ]);
    const service = createEncryptedObjectReencryptionService({
      context,
      repository: scope.reencryption,
      objects,
      objectKeys: keys.port,
      encryption: encryptionFor(context),
    });

    objects.failNext('get');
    await expect(
      service.runBatch({
        keyring: keyringFor(context, 2),
        limit: 1,
        performedAt: 2_000,
      }),
    ).rejects.toBeInstanceOf(FakePrivateObjectStorageError);
    expect(await currentMetadata(scope.metadata)).toMatchObject({
      objectKey: encryptedObjectIds.objectKeyA,
      dekVersion: envelopeCryptoIds.dekVersion1,
    });

    const failingKms = createEncryptedObjectReencryptionService({
      context,
      repository: scope.reencryption,
      objects,
      objectKeys: keys.port,
      encryption: encryptionFor(context, true),
    });
    await expect(
      failingKms.runBatch({
        keyring: keyringFor(context, 2),
        limit: 1,
        performedAt: 2_001,
      }),
    ).rejects.toBeInstanceOf(EncryptedObjectReencryptionIntegrityError);

    objects.failNext('put');
    await expect(
      service.runBatch({
        keyring: keyringFor(context, 2),
        limit: 1,
        performedAt: 2_002,
      }),
    ).rejects.toBeInstanceOf(FakePrivateObjectStorageError);
    expect(await currentMetadata(scope.metadata)).toMatchObject({
      objectKey: encryptedObjectIds.objectKeyA,
      dekVersion: envelopeCryptoIds.dekVersion1,
    });
    await expect(
      scope.metadata.listReadyDeletes({ now: 3_000, limit: 10 }),
    ).resolves.toEqual([]);

    objects.replaceForTest(encryptedObjectIds.objectKeyA, ciphertextB);
    await expect(
      service.runBatch({
        keyring: keyringFor(context, 2),
        limit: 1,
        performedAt: 2_003,
      }),
    ).rejects.toBeInstanceOf(EncryptedObjectReencryptionIntegrityError);
    objects.replaceForTest(encryptedObjectIds.objectKeyA, originalA);
    expect(await currentMetadata(scope.metadata)).toMatchObject({
      objectKey: encryptedObjectIds.objectKeyA,
      dekVersion: envelopeCryptoIds.dekVersion1,
    });
  });

  it('commits metadata CAS and old-object outbox idempotently in one D1 batch', async () => {
    const context = vaultContentContext('a');
    const scope = await openRepositories(casDatabase, context);
    const objects = createFakePrivateObjectStorage();
    const writer = createEncryptedObjectService({
      context,
      metadata: scope.metadata,
      objects,
      objectKeys: objectKeys([encryptedObjectIds.objectKeyA]).port,
      encryption: encryptionFor(context),
    });
    await writer.write(writeCommand(context, 'a'));
    const [candidate] = await scope.reencryption.listCandidates({
      targetVersion: envelopeCryptoIds.dekVersion2,
      after: null,
      limit: 1,
    });
    if (candidate === undefined) throw new Error('missing candidate');
    const replacement = {
      ...candidate,
      objectKey: encryptedObjectIds.objectKeyD,
      ciphertextBytes: candidate.ciphertextBytes + 1,
      dekVersion: envelopeCryptoIds.dekVersion2,
    };
    await expect(
      scope.reencryption.commit({
        expected: candidate,
        replacement,
        requestedAt: 2_000,
      }),
    ).resolves.toEqual({ kind: 'applied', metadata: replacement });
    await expect(
      scope.reencryption.commit({
        expected: candidate,
        replacement,
        requestedAt: 2_000,
      }),
    ).resolves.toEqual({ kind: 'replayed', metadata: replacement });
    await expect(
      scope.metadata.listReadyDeletes({ now: 2_000, limit: 10 }),
    ).resolves.toEqual([
      expect.objectContaining({ objectKey: encryptedObjectIds.objectKeyA }),
    ]);
    await expect(
      scope.reencryption.commit({
        expected: candidate,
        replacement: {
          ...replacement,
          objectKey: encryptedObjectIds.objectKeyE,
        },
        requestedAt: 2_001,
      }),
    ).resolves.toMatchObject({ kind: 'conflict', current: replacement });
  });
});

async function openRepositories(database: TestDatabase, context: VaultContext) {
  const controlPlane = new D1IdentityVaultControlPlane(database);
  const account = context.accountId === controlPlaneIds.accountA ? 'a' : 'b';
  await controlPlane.provisionPersonalAccount(
    personalAccountProvision(account),
  );
  const content = new D1VaultContentDirectory(database, controlPlane);
  await content.assignPartition(context, {
    partitionId: vaultContentIds.partitionHot,
    updatedAt: 1_000,
  });
  const metadata = await new D1EncryptedObjectMetadataDirectory(
    database,
    content,
  ).open(context);
  const reencryption = await new D1EncryptedObjectReencryptionDirectory(
    database,
    content,
  ).open(context);
  if (metadata.kind !== 'opened' || reencryption.kind !== 'opened') {
    throw new Error('missing encrypted object scope');
  }
  return {
    metadata: metadata.repository,
    reencryption: reencryption.repository,
  };
}

function writeCommand(context: VaultContext, card: 'a' | 'b') {
  return {
    object: {
      kind: 'card',
      objectId:
        card === 'a' ? envelopeCryptoIds.cardA : envelopeCryptoIds.cardB,
    } satisfies EnvelopeObject,
    expectedRevision: null,
    nextRevision: envelopeCryptoIds.objectRevision1,
    writeId:
      card === 'a' ? encryptedObjectIds.writeA : encryptedObjectIds.writeB,
    plaintext: new TextEncoder().encode(`same-size-card-${card}`),
    keyring: keyringFor(context, 1),
    createdAt: 1_000,
  } as const;
}

function keyringFor(context: VaultContext, version: 1 | 2): VaultDekKeyring {
  const first = envelopeDekMetadata(1, context.vaultId);
  return decodeVaultDekKeyring({
    vaultId: context.vaultId,
    writeVersion:
      version === 1
        ? envelopeCryptoIds.dekVersion1
        : envelopeCryptoIds.dekVersion2,
    versions:
      version === 1
        ? [first]
        : [first, envelopeDekMetadata(2, context.vaultId)],
  });
}

function encryptionFor(
  context: VaultContext,
  failUnwrap = false,
): EnvelopeEncryptionService {
  return createEnvelopeEncryptionService({
    keyManagement: createFakeKeyManagement({
      records: [
        {
          metadata: envelopeDekMetadata(1, context.vaultId),
          keyBytes: envelopeKeyBytes.version1,
        },
        {
          metadata: envelopeDekMetadata(2, context.vaultId),
          keyBytes: envelopeKeyBytes.version2,
        },
      ],
      failUnwrap,
    }),
    nonceGenerator: nonceGenerator(),
    nonceReservations: nonceReservations(),
    aesGcm: webCryptoAes256Gcm,
  });
}

function nonceGenerator() {
  let next = 0;
  return {
    async createNonce() {
      const bytes = new Uint8Array(12);
      bytes.fill(next);
      next += 1;
      let binary = '';
      for (const byte of bytes) binary += String.fromCharCode(byte);
      return btoa(binary)
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
    },
  };
}

function nonceReservations() {
  const reserved = new Set<string>();
  return {
    async reserve(input: {
      readonly vaultId: string;
      readonly dekVersion: number;
      readonly nonce: string;
    }) {
      const key = `${input.vaultId}:${input.dekVersion}:${input.nonce}`;
      if (reserved.has(key)) return false;
      reserved.add(key);
      return true;
    },
  };
}

function objectKeys(keys: readonly unknown[]) {
  let index = 0;
  return {
    port: {
      async createObjectKey() {
        const key = keys[index];
        index += 1;
        if (key === undefined) throw new Error('object key fixture exhausted');
        return key;
      },
    } satisfies OpaqueObjectKeyGeneratorPort,
    calls() {
      return index;
    },
  };
}

function countedEncryption(base: EnvelopeEncryptionService) {
  let encrypt = 0;
  let decrypt = 0;
  return {
    port: {
      async encrypt(
        input: Parameters<EnvelopeEncryptionService['encrypt']>[0],
      ) {
        encrypt += 1;
        return base.encrypt(input);
      },
      async decrypt(
        input: Parameters<EnvelopeEncryptionService['decrypt']>[0],
      ) {
        decrypt += 1;
        return base.decrypt(input);
      },
    } satisfies EnvelopeEncryptionService,
    calls() {
      return { encrypt, decrypt };
    },
  };
}

async function currentMetadata(repository: EncryptedObjectMetadataRepository) {
  return repository.findRevision(
    writeCommand(vaultContentContext('a'), 'a').object,
    envelopeCryptoIds.objectRevision1,
  );
}
