import { Miniflare } from 'miniflare';
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { VaultContext } from '@/lib/domain/identity';
import type { PendingMutation } from '@/lib/domain/types';
import {
  decodeSyncV2Response,
  encodeSyncV2Request,
  parseSyncSequence,
} from '@/lib/sync/v2-protocol';
import { SYNC_V2_CURSOR_VERSION } from '@/lib/sync/v2-cursor';
import { createFakeKeyManagement } from '@/server/adapters/fake-key-management';
import { createFakePrivateObjectStorage } from '@/server/adapters/fake-private-object-storage';
import { createD1BillingApi } from '@/server/billing/d1-adapter';
import { createD1SyncV2HttpHandler } from '@/server/composition/sync-v2';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import {
  decodeVaultDekKeyring,
  type VaultDekKeyring,
} from '@/server/crypto/core';
import {
  createEnvelopeEncryptionService,
  type EnvelopeEncryptionService,
} from '@/server/crypto/envelope-service';
import { webCryptoAes256Gcm } from '@/server/crypto/web-aes-gcm';
import type { OpaqueObjectKeyGeneratorPort } from '@/server/encrypted-object/ports';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import {
  createWebCryptoSyncV2CursorAuthenticator,
  webCryptoSyncV2MutationFingerprints,
} from '@/server/sync-v2/web-crypto';
import { D1VaultContentDirectory } from '@/server/vault-content/d1-adapter';
import { parseContentRevision } from '@/server/vault-content/records';
import { D1SyncV2JournalDirectory } from '@/server/vault-content/sync-v2-d1-adapter';
import { parseSyncV2MutationFingerprint } from '@/server/vault-content/sync-v2-public';
import {
  beginCheckoutCommand,
  paymentFailedFact,
  trialStartedFact,
} from '@/tests/fixtures/billing';
import { createCompatibilityFixture } from '@/tests/fixtures/compatibility';
import {
  activeControlPlaneSession,
  controlPlaneContext,
  controlPlaneIds,
  controlPlaneTokenHash,
  personalAccountProvision,
} from '@/tests/fixtures/control-plane';
import {
  envelopeDekMetadata,
  envelopeKeyBytes,
  envelopeCryptoIds,
} from '@/tests/fixtures/envelope-crypto';
import { encryptedObjectIds } from '@/tests/fixtures/encrypted-object';
import { fixtureCardId, fixtureMutationId } from '@/tests/fixtures/ids';
import { cookieHeader } from '@/tests/fixtures/session';
import { vaultContentIds } from '@/tests/fixtures/vault-content';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const expectedOrigin = 'https://notes.example';
const deviceId = createCompatibilityFixture().request.deviceId;
const cursorSecret = new Uint8Array(32).fill(0x51);
const flowMutation = mutation('sync-v2-server-flow');
const recoveryMutation = mutation('sync-v2-server-recovery');

// The end-to-end D1 composition exercises auth, encryption, cursor paging,
// tombstones, replay, and billing in one fixture. Full verification measured
// 5.038s, just above Vitest's incidental 5s default; retain a finite local
// hang guard without changing assertions or the global test configuration.
vi.setConfig({ testTimeout: 15_000 });

let miniflare: Miniflare;
let flowDatabase: TestDatabase;
let recoveryDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: ['FLOW', 'RECOVERY'],
  });
  flowDatabase = await miniflare.getD1Database('FLOW');
  recoveryDatabase = await miniflare.getD1Database('RECOVERY');
  for (const database of [flowDatabase, recoveryDatabase]) {
    await runD1Migrations({
      database,
      manifest: productionMigrationManifest,
      appliedAt: 1_000,
    });
    await database.prepare('PRAGMA foreign_keys = ON').run();
    await provision(database);
  }
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await miniflare.dispose();
});

describe('D1 Sync v2 server composition', () => {
  it('authenticates, encrypts, replays, pages tombstones, isolates cursors, and enforces billing lock', async () => {
    const now = mutableClock(1_500);
    const objects = createFakePrivateObjectStorage();
    const encryption = countedEncryption(encryptionFor(controlPlaneContext()));
    const cursors = createWebCryptoSyncV2CursorAuthenticator(cursorSecret);
    const handler = createHandler({
      database: flowDatabase,
      now,
      objects,
      encryption: encryption.port,
      cursors,
      objectKeys: objectKeys([encryptedObjectIds.objectKeyA]),
      keyring: keyringFor(controlPlaneContext().vaultId),
    });

    const firstResponse = await handler(syncRequest([flowMutation]));
    expect(firstResponse.status).toBe(200);
    const first = decodeSyncV2Response(await firstResponse.json(), [
      flowMutation,
    ]);
    expect(first).toMatchObject({
      highWatermark: 1,
      changes: [
        {
          kind: 'card-upsert',
          card: { id: flowMutation.cardId, officialDisplayId: 1 },
        },
      ],
      receipts: [
        {
          mutationId: flowMutation.mutationId,
          cardId: flowMutation.cardId,
          appliedRevision: 1,
        },
      ],
      page: { kind: 'complete' },
    });

    const afterFirst = adapterCalls(objects.calls(), encryption.calls());
    const replayResponse = await handler(
      syncRequest([flowMutation], first.page.nextCursor),
    );
    expect(replayResponse.status).toBe(200);
    const replay = decodeSyncV2Response(await replayResponse.json(), [
      flowMutation,
    ]);
    expect(replay.changes).toEqual([]);
    expect(replay.receipts).toHaveLength(1);
    expect(adapterCalls(objects.calls(), encryption.calls())).toEqual(
      afterFirst,
    );

    const journal = await openJournal(flowDatabase, controlPlaneContext());
    await expect(
      journal.commit({
        kind: 'card-delete',
        mutationId: fixtureMutationId('sync-v2-server-delete'),
        fingerprint: parseSyncV2MutationFingerprint(`${'z'.repeat(42)}A`),
        cardId: flowMutation.cardId,
        expectedRevision: parseContentRevision(1),
        tombstoneRevision: parseContentRevision(2),
        deletedAt: 1_550,
        committedAt: 1_550,
      }),
    ).resolves.toMatchObject({ kind: 'applied' });

    const beforeTombstone = adapterCalls(objects.calls(), encryption.calls());
    const tombstoneResponse = await handler(
      syncRequest([], replay.page.nextCursor),
    );
    const tombstone = decodeSyncV2Response(await tombstoneResponse.json(), []);
    expect(tombstone.changes).toEqual([
      {
        kind: 'card-tombstone',
        sequence: parseSyncSequence(2),
        cardId: flowMutation.cardId,
        revision: 2,
        deletedAt: 1_550,
      },
    ]);
    expect(adapterCalls(objects.calls(), encryption.calls())).toEqual(
      beforeTombstone,
    );

    const noChangeResponse = await handler(
      syncRequest([], tombstone.page.nextCursor),
    );
    expect(
      decodeSyncV2Response(await noChangeResponse.json(), []).changes,
    ).toEqual([]);
    expect(adapterCalls(objects.calls(), encryption.calls())).toEqual(
      beforeTombstone,
    );

    const foreignCursor = await cursors.issue({
      version: SYNC_V2_CURSOR_VERSION,
      vaultId: controlPlaneIds.vaultB,
      deviceId,
      afterSequence: parseSyncSequence(0),
      highWatermark: parseSyncSequence(0),
    });
    const crossVault = await handler(syncRequest([], foreignCursor));
    expect(crossVault.status).toBe(400);
    expect(await crossVault.json()).toEqual({ error: 'invalid-request' });
    expect(adapterCalls(objects.calls(), encryption.calls())).toEqual(
      beforeTombstone,
    );

    const billing = createD1BillingApi(
      flowDatabase,
      new D1IdentityVaultControlPlane(flowDatabase),
    );
    await billing.ingestVerifiedProviderFact(paymentFailedFact(1_600));
    now.set(1_700);
    const locked = await handler(syncRequest([], tombstone.page.nextCursor));
    expect(locked.status).toBe(402);
    expect(await locked.json()).toEqual({ error: 'online-access-locked' });
    expect(adapterCalls(objects.calls(), encryption.calls())).toEqual(
      beforeTombstone,
    );
  });

  it('fails closed on malformed keyring and resumes after an atomic D1 journal failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const now = mutableClock(1_500);
    const objects = createFakePrivateObjectStorage();
    const encryption = countedEncryption(encryptionFor(controlPlaneContext()));
    const shared = {
      database: recoveryDatabase,
      now,
      objects,
      encryption: encryption.port,
      cursors: createWebCryptoSyncV2CursorAuthenticator(cursorSecret),
      objectKeys: objectKeys([encryptedObjectIds.objectKeyB]),
    } as const;

    const malformed = createHandler({ ...shared, keyring: {} });
    const malformedResponse = await malformed(syncRequest([recoveryMutation]));
    expect(malformedResponse.status).toBe(503);
    expect(objects.calls()).toMatchObject({ get: 0, put: 0 });
    expect(encryption.calls()).toEqual({ encrypt: 0, decrypt: 0 });

    await recoveryDatabase
      .prepare(
        `CREATE TRIGGER fail_sync_v2_server_change
         BEFORE INSERT ON vault_sync_v2_changes
         BEGIN SELECT RAISE(ABORT, 'injected sync v2 journal failure'); END`,
      )
      .run();
    const handler = createHandler({
      ...shared,
      keyring: keyringFor(controlPlaneContext().vaultId),
    });
    const failed = await handler(syncRequest([recoveryMutation]));
    expect(failed.status).toBe(503);
    expect(objects.calls()).toMatchObject({ put: 1 });
    expect(encryption.calls()).toMatchObject({ encrypt: 1 });

    await recoveryDatabase
      .prepare('DROP TRIGGER fail_sync_v2_server_change')
      .run();
    const beforeRetry = adapterCalls(objects.calls(), encryption.calls());
    const retried = await handler(syncRequest([recoveryMutation]));
    expect(retried.status).toBe(200);
    const response = decodeSyncV2Response(await retried.json(), [
      recoveryMutation,
    ]);
    expect(response.receipts).toHaveLength(1);
    expect(objects.calls().put).toBe(beforeRetry.put);
    expect(encryption.calls().encrypt).toBe(beforeRetry.encrypt);
  });
});

async function provision(database: TestDatabase): Promise<void> {
  const context = controlPlaneContext();
  const controlPlane = new D1IdentityVaultControlPlane(database);
  await controlPlane.provisionPersonalAccount(personalAccountProvision('a'));
  await controlPlane.createSession({
    session: activeControlPlaneSession(),
    tokenHash: controlPlaneTokenHash,
  });
  await new D1VaultContentDirectory(database, controlPlane).assignPartition(
    context,
    { partitionId: vaultContentIds.partitionHot, updatedAt: 1_000 },
  );
  const billing = createD1BillingApi(database, controlPlane);
  await billing.beginCheckout(context, beginCheckoutCommand());
  await billing.ingestVerifiedProviderFact(trialStartedFact(1_200));
}

function createHandler(input: {
  readonly database: TestDatabase;
  readonly now: ReturnType<typeof mutableClock>;
  readonly objects: ReturnType<typeof createFakePrivateObjectStorage>;
  readonly encryption: EnvelopeEncryptionService;
  readonly cursors: ReturnType<typeof createWebCryptoSyncV2CursorAuthenticator>;
  readonly objectKeys: OpaqueObjectKeyGeneratorPort;
  readonly keyring: unknown;
}) {
  return createD1SyncV2HttpHandler({
    database: input.database,
    expectedOrigin,
    clock: input.now,
    sessionTokenHashes: { digest: async () => controlPlaneTokenHash },
    cursors: input.cursors,
    fingerprints: webCryptoSyncV2MutationFingerprints,
    objects: input.objects,
    objectKeys: input.objectKeys,
    encryption: input.encryption,
    keyrings: { read: async () => input.keyring },
  });
}

function syncRequest(
  mutations: readonly PendingMutation[],
  cursor: Parameters<typeof encodeSyncV2Request>[0]['cursor'] = null,
): Request {
  return new Request(`${expectedOrigin}/api/v2/sync`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader(),
      origin: expectedOrigin,
      'sec-fetch-site': 'same-origin',
    },
    body: JSON.stringify(encodeSyncV2Request({ deviceId, cursor, mutations })),
  });
}

function mutation(label: string): PendingMutation {
  return {
    kind: 'upsert',
    mutationId: fixtureMutationId(`${label}-mutation`),
    cardId: fixtureCardId(`${label}-card`),
    baseServerRevision: null,
    title: 'Encrypted server card',
    body: [{ type: 'text', text: 'tenant-only plaintext' }],
    createdAt: 1_100,
    updatedAt: 1_300,
    conflictIds: [],
  };
}

async function openJournal(database: TestDatabase, context: VaultContext) {
  const controlPlane = new D1IdentityVaultControlPlane(database);
  const contents = new D1VaultContentDirectory(database, controlPlane);
  const opened = await new D1SyncV2JournalDirectory(database, contents).open(
    context,
  );
  if (opened.kind === 'not-found') throw new Error('missing journal scope');
  return opened.repository;
}

function keyringFor(vaultId: VaultContext['vaultId']): VaultDekKeyring {
  return decodeVaultDekKeyring({
    vaultId,
    writeVersion: envelopeCryptoIds.dekVersion1,
    versions: [envelopeDekMetadata(1, vaultId)],
  });
}

function encryptionFor(context: VaultContext): EnvelopeEncryptionService {
  const metadata = envelopeDekMetadata(1, context.vaultId);
  return createEnvelopeEncryptionService({
    keyManagement: createFakeKeyManagement({
      records: [{ metadata, keyBytes: envelopeKeyBytes.version1 }],
    }),
    nonceGenerator: deterministicNonces(),
    nonceReservations: nonceReservations(),
    aesGcm: webCryptoAes256Gcm,
  });
}

function deterministicNonces() {
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
        .replace(/=+$/u, '');
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

function objectKeys(keys: readonly unknown[]): OpaqueObjectKeyGeneratorPort {
  let index = 0;
  return {
    async createObjectKey() {
      const key = keys[index];
      index += 1;
      if (key === undefined) throw new Error('object key fixture exhausted');
      return key;
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

function adapterCalls(
  objects: ReturnType<
    ReturnType<typeof createFakePrivateObjectStorage>['calls']
  >,
  encryption: { readonly encrypt: number; readonly decrypt: number },
) {
  return {
    get: objects.get,
    put: objects.put,
    encrypt: encryption.encrypt,
    decrypt: encryption.decrypt,
  };
}

function mutableClock(initial: number) {
  let current = initial;
  return {
    now: () => current,
    set(next: number) {
      current = next;
    },
  };
}
