import { Miniflare } from 'miniflare';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { VaultContext } from '@/lib/domain/identity';
import type { EnvelopeObject, VaultDekKeyring } from '@/server/crypto/core';
import { decodeVaultDekKeyring } from '@/server/crypto/core';
import {
  createEnvelopeEncryptionService,
  type EnvelopeEncryptionService,
} from '@/server/crypto/envelope-service';
import {
  EnvelopeAuthenticationError,
  webCryptoAes256Gcm,
} from '@/server/crypto/web-aes-gcm';
import { createFakeKeyManagement } from '@/server/adapters/fake-key-management';
import {
  FakePrivateObjectStorageError,
  createFakePrivateObjectStorage,
} from '@/server/adapters/fake-private-object-storage';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import { D1EncryptedObjectMetadataDirectory } from '@/server/encrypted-object/d1-adapter';
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
import {
  encryptedObjectIds,
  pendingEncryptedWrite,
} from '@/tests/fixtures/encrypted-object';
import {
  vaultContentContext,
  vaultContentIds,
} from '@/tests/fixtures/vault-content';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

let miniflare: Miniflare;
let idempotencyDatabase: TestDatabase;
let recoveryDatabase: TestDatabase;
let securityDatabase: TestDatabase;
let gcDatabase: TestDatabase;
let tenantDatabase: TestDatabase;
let limitDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: [
      'IDEMPOTENCY',
      'RECOVERY',
      'SECURITY',
      'GC',
      'TENANT',
      'LIMIT',
    ],
  });
  idempotencyDatabase = await miniflare.getD1Database('IDEMPOTENCY');
  recoveryDatabase = await miniflare.getD1Database('RECOVERY');
  securityDatabase = await miniflare.getD1Database('SECURITY');
  gcDatabase = await miniflare.getD1Database('GC');
  tenantDatabase = await miniflare.getD1Database('TENANT');
  limitDatabase = await miniflare.getD1Database('LIMIT');
  for (const database of [
    idempotencyDatabase,
    recoveryDatabase,
    securityDatabase,
    gcDatabase,
    tenantDatabase,
    limitDatabase,
  ]) {
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

describe('encrypted object application service', () => {
  it('replays a lost response without another object or KMS call', async () => {
    const context = vaultContentContext('a');
    const repository = await openRepository(idempotencyDatabase, context);
    const objects = createFakePrivateObjectStorage();
    const encryption = countedEncryption(encryptionFor(context));
    const keys = objectKeys([
      encryptedObjectIds.objectKeyA,
      encryptedObjectIds.objectKeyB,
    ]);
    const service = createEncryptedObjectService({
      context,
      metadata: repository,
      objects,
      objectKeys: keys.port,
      encryption: encryption.port,
    });
    const command = firstWrite();

    const stored = await service.write(command);
    expect(stored).toMatchObject({ kind: 'stored' });
    const objectCalls = objects.calls();
    const cryptoCalls = encryption.calls();
    const keyCalls = keys.calls();
    await expect(service.write(command)).resolves.toEqual({
      kind: 'replayed',
      metadata: stored.kind === 'stored' ? stored.metadata : undefined,
    });
    expect(objects.calls()).toEqual(objectCalls);
    expect(encryption.calls()).toEqual(cryptoCalls);
    expect(keys.calls()).toBe(keyCalls);

    await expect(
      service.read({ object: command.object, keyring: command.keyring }),
    ).resolves.toEqual({
      kind: 'found',
      plaintext: command.plaintext,
    });
    await expect(service.write(secondRevisionWrite())).resolves.toMatchObject({
      kind: 'stored',
      metadata: { objectRevision: envelopeCryptoIds.objectRevision2 },
    });
    await expect(
      service.readRevision({
        object: command.object,
        objectRevision: envelopeCryptoIds.objectRevision1,
        keyring: command.keyring,
      }),
    ).resolves.toEqual({
      kind: 'found',
      plaintext: command.plaintext,
    });
    const beforeMissingRead = objects.calls();
    await expect(
      service.read({
        object: { kind: 'card', objectId: envelopeCryptoIds.cardB },
        keyring: command.keyring,
      }),
    ).resolves.toEqual({ kind: 'not-found' });
    expect(objects.calls()).toEqual(beforeMissingRead);
  });

  it('resumes the same immutable object after a D1 commit failure', async () => {
    const context = vaultContentContext('a');
    const repository = await openRepository(recoveryDatabase, context);
    const failure = failFirstCommit(repository);
    const objects = createFakePrivateObjectStorage();
    const encryption = countedEncryption(encryptionFor(context));
    const keys = objectKeys([
      encryptedObjectIds.objectKeyA,
      encryptedObjectIds.objectKeyB,
    ]);
    const command = firstWrite();
    const failingService = createEncryptedObjectService({
      context,
      metadata: failure,
      objects,
      objectKeys: keys.port,
      encryption: encryption.port,
    });
    await expect(failingService.write(command)).rejects.toThrow(
      'injected D1 commit failure',
    );
    expect(objects.calls()).toMatchObject({ put: 1 });
    expect(encryption.calls()).toEqual({ encrypt: 1, decrypt: 0 });

    const resumedService = createEncryptedObjectService({
      context,
      metadata: repository,
      objects,
      objectKeys: keys.port,
      encryption: encryption.port,
    });
    await expect(resumedService.write(command)).resolves.toMatchObject({
      kind: 'stored',
    });
    expect(objects.calls()).toMatchObject({ put: 1 });
    expect(encryption.calls()).toEqual({ encrypt: 1, decrypt: 1 });

    const rejectedService = createEncryptedObjectService({
      context,
      metadata: rejectCommit(repository),
      objects,
      objectKeys: keys.port,
      encryption: encryption.port,
    });
    await expect(rejectedService.write(secondRevisionWrite())).resolves.toEqual(
      { kind: 'not-applied', reason: 'cas-conflict' },
    );
    await expect(
      objects.get(encryptedObjectIds.objectKeyB),
    ).resolves.toBeDefined();
    await expect(
      resumedService.drainDeleteOutbox({
        now: 2_000,
        retryDelayMs: 5_000,
        limit: 10,
      }),
    ).resolves.toEqual({ completed: 1, retried: 0 });
    await expect(
      objects.get(encryptedObjectIds.objectKeyB),
    ).resolves.toBeUndefined();
  });

  it('fails closed for KMS/R2 failures and rejects ciphertext swaps', async () => {
    const context = vaultContentContext('a');
    const repository = await openRepository(securityDatabase, context);
    const objects = createFakePrivateObjectStorage();
    const keys = objectKeys([
      encryptedObjectIds.objectKeyA,
      encryptedObjectIds.objectKeyB,
      encryptedObjectIds.objectKeyC,
    ]);
    const failingKmsService = createEncryptedObjectService({
      context,
      metadata: repository,
      objects,
      objectKeys: keys.port,
      encryption: encryptionFor(context, true),
    });
    await expect(failingKmsService.write(firstWrite())).rejects.toThrow();
    expect(objects.calls().put).toBe(0);

    const workingService = createEncryptedObjectService({
      context,
      metadata: repository,
      objects,
      objectKeys: keys.port,
      encryption: encryptionFor(context),
    });
    objects.failNext('put');
    await expect(workingService.write(firstWrite())).rejects.toBeInstanceOf(
      FakePrivateObjectStorageError,
    );
    await expect(workingService.write(firstWrite())).resolves.toMatchObject({
      kind: 'stored',
    });
    const second = secondCardWrite();
    await expect(workingService.write(second)).resolves.toMatchObject({
      kind: 'stored',
    });

    const firstBytes = await objects.get(encryptedObjectIds.objectKeyA);
    const secondBytes = await objects.get(encryptedObjectIds.objectKeyB);
    expect(firstBytes).toBeDefined();
    if (secondBytes === undefined) throw new Error('missing encrypted fixture');
    objects.replaceForTest(encryptedObjectIds.objectKeyA, secondBytes);
    await expect(
      workingService.read({
        object: firstWrite().object,
        keyring: firstWrite().keyring,
      }),
    ).rejects.toBeInstanceOf(EnvelopeAuthenticationError);
  });

  it('queues old orphans and retries private object deletion', async () => {
    const context = vaultContentContext('a');
    const repository = await openRepository(gcDatabase, context);
    const objects = createFakePrivateObjectStorage([
      {
        objectKey: encryptedObjectIds.objectKeyC,
        bytes: new Uint8Array([1]),
        createdAt: 1_000,
      },
      {
        objectKey: encryptedObjectIds.objectKeyD,
        bytes: new Uint8Array([2]),
        createdAt: 9_500,
      },
    ]);
    const service = createEncryptedObjectService({
      context,
      metadata: repository,
      objects,
      objectKeys: objectKeys([encryptedObjectIds.objectKeyA]).port,
      encryption: encryptionFor(context),
    });
    await expect(
      service.collectOrphans({ scanStartedAt: 10_000, gracePeriodMs: 1_000 }),
    ).resolves.toEqual({ enqueued: 1 });
    objects.failNext('delete');
    await expect(
      service.drainDeleteOutbox({
        now: 10_000,
        retryDelayMs: 5_000,
        limit: 10,
      }),
    ).resolves.toEqual({ completed: 0, retried: 1 });
    await expect(
      service.drainDeleteOutbox({
        now: 14_999,
        retryDelayMs: 5_000,
        limit: 10,
      }),
    ).resolves.toEqual({ completed: 0, retried: 0 });
    await expect(
      service.drainDeleteOutbox({
        now: 15_000,
        retryDelayMs: 5_000,
        limit: 10,
      }),
    ).resolves.toEqual({ completed: 1, retried: 0 });
    await expect(
      objects.get(encryptedObjectIds.objectKeyC),
    ).resolves.toBeUndefined();
    await expect(objects.get(encryptedObjectIds.objectKeyD)).resolves.toEqual(
      new Uint8Array([2]),
    );
  });

  it('rejects an encoded ciphertext above the configured ceiling before upload', async () => {
    const context = vaultContentContext('a');
    const repository = await openRepository(limitDatabase, context);
    const objects = createFakePrivateObjectStorage();
    const service = createEncryptedObjectService({
      context,
      metadata: repository,
      objects,
      objectKeys: objectKeys([encryptedObjectIds.objectKeyA]).port,
      encryption: encryptionFor(context),
      maximumCiphertextBytes: 1,
    });
    await expect(service.write(firstWrite())).resolves.toEqual({
      kind: 'not-applied',
      reason: 'ciphertext-limit',
    });
    expect(objects.calls().put).toBe(0);
    await expect(
      repository.findIntent(encryptedObjectIds.writeA),
    ).resolves.toBeUndefined();
    await expect(
      repository.findCurrent(firstWrite().object),
    ).resolves.toBeUndefined();
  });

  it('isolates equal write, object, and key identifiers by Vault', async () => {
    const repositoryA = await openRepository(
      tenantDatabase,
      vaultContentContext('a'),
    );
    const repositoryB = await openRepository(
      tenantDatabase,
      vaultContentContext('b'),
    );
    const intent = pendingEncryptedWrite();
    await expect(repositoryA.reserveIntent(intent)).resolves.toMatchObject({
      kind: 'reserved',
    });
    await expect(
      repositoryA.reserveIntent(
        pendingEncryptedWrite({ write: 'b', key: 'b' }),
      ),
    ).resolves.toEqual({ kind: 'conflict' });
    await expect(repositoryB.reserveIntent(intent)).resolves.toMatchObject({
      kind: 'reserved',
    });
  });
});

async function openRepository(
  database: TestDatabase,
  context: VaultContext,
): Promise<EncryptedObjectMetadataRepository> {
  const controlPlane = new D1IdentityVaultControlPlane(database);
  const account = context.accountId === controlPlaneIds.accountA ? 'a' : 'b';
  await controlPlane.provisionPersonalAccount(
    personalAccountProvision(account),
  );
  const contentDirectory = new D1VaultContentDirectory(database, controlPlane);
  await contentDirectory.assignPartition(context, {
    partitionId: vaultContentIds.partitionHot,
    updatedAt: 1_000,
  });
  const result = await new D1EncryptedObjectMetadataDirectory(
    database,
    contentDirectory,
  ).open(context);
  if (result.kind === 'not-found') throw new Error('missing encrypted scope');
  return result.repository;
}

function firstWrite() {
  return {
    object: {
      kind: 'card',
      objectId: envelopeCryptoIds.cardA,
    } satisfies EnvelopeObject,
    expectedRevision: null,
    nextRevision: envelopeCryptoIds.objectRevision1,
    writeId: encryptedObjectIds.writeA,
    plaintext: new TextEncoder().encode('same-size-card-a'),
    keyring: keyringFor(controlPlaneIds.vaultA),
    createdAt: 1_000,
  } as const;
}

function secondCardWrite() {
  return {
    object: {
      kind: 'card',
      objectId: envelopeCryptoIds.cardB,
    } satisfies EnvelopeObject,
    expectedRevision: null,
    nextRevision: envelopeCryptoIds.objectRevision1,
    writeId: encryptedObjectIds.writeB,
    plaintext: new TextEncoder().encode('same-size-card-b'),
    keyring: keyringFor(controlPlaneIds.vaultA),
    createdAt: 1_000,
  } as const;
}

function secondRevisionWrite() {
  return {
    object: firstWrite().object,
    expectedRevision: envelopeCryptoIds.objectRevision1,
    nextRevision: envelopeCryptoIds.objectRevision2,
    writeId: encryptedObjectIds.writeB,
    plaintext: new TextEncoder().encode('revision-two-data'),
    keyring: keyringFor(controlPlaneIds.vaultA),
    createdAt: 2_000,
  } as const;
}

function keyringFor(vaultId: VaultContext['vaultId']): VaultDekKeyring {
  const metadata = envelopeDekMetadata(1, vaultId);
  return decodeVaultDekKeyring({
    vaultId,
    writeVersion: envelopeCryptoIds.dekVersion1,
    versions: [metadata],
  });
}

function encryptionFor(
  context: VaultContext,
  failUnwrap = false,
): EnvelopeEncryptionService {
  const metadata = envelopeDekMetadata(1, context.vaultId);
  return createEnvelopeEncryptionService({
    keyManagement: createFakeKeyManagement({
      records: [{ metadata, keyBytes: envelopeKeyBytes.version1 }],
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

function failFirstCommit(
  repository: EncryptedObjectMetadataRepository,
): EncryptedObjectMetadataRepository {
  let shouldFail = true;
  return {
    findCurrent: (object) => repository.findCurrent(object),
    findRevision: (object, revision) =>
      repository.findRevision(object, revision),
    findByWriteId: (writeId) => repository.findByWriteId(writeId),
    findIntent: (writeId) => repository.findIntent(writeId),
    reserveIntent: (intent) => repository.reserveIntent(intent),
    async commitIntent(input) {
      if (shouldFail) {
        shouldFail = false;
        throw new Error('injected D1 commit failure');
      }
      return repository.commitIntent(input);
    },
    abandonIntent: (input) => repository.abandonIntent(input),
    listProtectedObjectKeys: () => repository.listProtectedObjectKeys(),
    enqueueDelete: (input) => repository.enqueueDelete(input),
    listReadyDeletes: (input) => repository.listReadyDeletes(input),
    completeDelete: (entry) => repository.completeDelete(entry),
    rescheduleDelete: (entry) => repository.rescheduleDelete(entry),
  };
}

function rejectCommit(
  repository: EncryptedObjectMetadataRepository,
): EncryptedObjectMetadataRepository {
  return {
    findCurrent: (object) => repository.findCurrent(object),
    findRevision: (object, revision) =>
      repository.findRevision(object, revision),
    findByWriteId: (writeId) => repository.findByWriteId(writeId),
    findIntent: (writeId) => repository.findIntent(writeId),
    reserveIntent: (intent) => repository.reserveIntent(intent),
    async commitIntent() {
      return { kind: 'not-applied' };
    },
    abandonIntent: (input) => repository.abandonIntent(input),
    listProtectedObjectKeys: () => repository.listProtectedObjectKeys(),
    enqueueDelete: (input) => repository.enqueueDelete(input),
    listReadyDeletes: (input) => repository.listReadyDeletes(input),
    completeDelete: (entry) => repository.completeDelete(entry),
    rescheduleDelete: (entry) => repository.rescheduleDelete(entry),
  };
}
