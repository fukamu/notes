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
  decodeSyncV2Request,
  decodeSyncV2Response,
  encodeSyncV2Request,
  parseSyncSequence,
} from '@/lib/sync/v2-protocol';
import { SYNC_V2_CURSOR_VERSION } from '@/lib/sync/v2-cursor';
import { createFakeKeyManagement } from '@/server/adapters/fake-key-management';
import { createFakePrivateObjectStorage } from '@/server/adapters/fake-private-object-storage';
import { createD1BillingApi } from '@/server/billing/d1-adapter';
import { createD1SyncV2Composition } from '@/server/composition/sync-v2';
import { D1IdentityVaultControlPlane } from '@/server/control-plane/d1-adapter';
import {
  decodeVaultDekKeyring,
  type VaultDekKeyring,
} from '@/server/crypto/core';
import {
  createEnvelopeEncryptionService,
  type EnvelopeEncryptionService,
} from '@/server/crypto/envelope-service';
import { paidPersonalVaultLimits } from '@/server/entitlement/public';
import { D1VaultQuotaLedgerDirectory } from '@/server/quota/d1-adapter';
import { parseQuotaByteCount } from '@/server/quota/public';
import { webCryptoAes256Gcm } from '@/server/crypto/web-aes-gcm';
import type { OpaqueObjectKeyGeneratorPort } from '@/server/encrypted-object/ports';
import { productionMigrationManifest } from '@/server/migrations/production';
import { runD1Migrations } from '@/server/migrations/d1-runner';
import { encodeSyncV2StoredCard } from '@/server/sync-v2/content-codec';
import {
  createWebCryptoSyncV2CursorAuthenticator,
  webCryptoSyncV2MutationFingerprints,
} from '@/server/sync-v2/web-crypto';
import { D1VaultContentDirectory } from '@/server/vault-content/d1-adapter';
import { parseContentRevision } from '@/server/vault-content/records';
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
import { vaultContentContext } from '@/tests/fixtures/vault-content';

type TestDatabase = Awaited<ReturnType<Miniflare['getD1Database']>>;

const expectedOrigin = 'https://notes.example';
const deviceId = createCompatibilityFixture().request.deviceId;
const cursorSecret = new Uint8Array(32).fill(0x51);
const flowMutation = mutation('sync-v2-server-flow');
const flowUpdateMutation: PendingMutation = {
  ...flowMutation,
  mutationId: fixtureMutationId('sync-v2-server-flow-update'),
  baseServerRevision: 1,
  title: 'Updated encrypted server card',
  body: [{ type: 'text', text: 'updated tenant-only plaintext' }],
  updatedAt: 1_450,
};
const recoveryMutation = mutation('sync-v2-server-recovery');

// The end-to-end D1 composition exercises auth, encryption, cursor paging,
// tombstones, replay, and billing in one fixture. Full verification measured
// 5.038s, just above Vitest's incidental 5s default; retain a finite local
// hang guard without changing assertions or the global test configuration.
vi.setConfig({ testTimeout: 15_000 });

let miniflare: Miniflare;
let flowDatabase: TestDatabase;
let recoveryDatabase: TestDatabase;
let limitsDatabase: TestDatabase;
let conflictDatabase: TestDatabase;
let concurrencyDatabase: TestDatabase;
let tenantsDatabase: TestDatabase;

beforeAll(async () => {
  miniflare = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("ok") } }',
    d1Databases: [
      'FLOW',
      'RECOVERY',
      'LIMITS',
      'CONFLICT',
      'CONCURRENCY',
      'TENANTS',
    ],
  });
  flowDatabase = await miniflare.getD1Database('FLOW');
  recoveryDatabase = await miniflare.getD1Database('RECOVERY');
  limitsDatabase = await miniflare.getD1Database('LIMITS');
  conflictDatabase = await miniflare.getD1Database('CONFLICT');
  concurrencyDatabase = await miniflare.getD1Database('CONCURRENCY');
  tenantsDatabase = await miniflare.getD1Database('TENANTS');
  for (const database of [
    flowDatabase,
    recoveryDatabase,
    limitsDatabase,
    conflictDatabase,
    concurrencyDatabase,
    tenantsDatabase,
  ]) {
    await runD1Migrations({
      database,
      manifest: productionMigrationManifest,
      appliedAt: 1_000,
    });
    await database.prepare('PRAGMA foreign_keys = ON').run();
  }
  for (const database of [
    flowDatabase,
    recoveryDatabase,
    limitsDatabase,
    conflictDatabase,
    concurrencyDatabase,
  ]) {
    await provision(database);
  }
  await provisionTwoVaults(tenantsDatabase);
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
    const composition = createComposition({
      database: flowDatabase,
      now,
      objects,
      encryption: encryption.port,
      cursors,
      objectKeys: objectKeys([
        encryptedObjectIds.objectKeyA,
        encryptedObjectIds.objectKeyB,
      ]),
      keyring: keyringFor(controlPlaneContext().vaultId),
    });
    const handler = composition.handler;

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
    await expect(quotaUsage(flowDatabase)).resolves.toMatchObject({
      active_cards: 1,
      plaintext_bytes: encodeSyncV2StoredCard({
        title: flowMutation.title,
        body: flowMutation.body,
        createdAt: flowMutation.createdAt,
        updatedAt: flowMutation.updatedAt,
      }).byteLength,
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

    const updateResponse = await handler(
      syncRequest([flowUpdateMutation], replay.page.nextCursor),
    );
    expect(updateResponse.status).toBe(200);
    const updated = decodeSyncV2Response(await updateResponse.json(), [
      flowUpdateMutation,
    ]);
    expect(updated.receipts).toEqual([
      {
        mutationId: flowUpdateMutation.mutationId,
        cardId: flowUpdateMutation.cardId,
        appliedRevision: 2,
      },
    ]);
    await expect(quotaUsage(flowDatabase)).resolves.toMatchObject({
      active_cards: 1,
      plaintext_bytes: encodeSyncV2StoredCard({
        title: flowUpdateMutation.title,
        body: flowUpdateMutation.body,
        createdAt: flowUpdateMutation.createdAt,
        updatedAt: flowUpdateMutation.updatedAt,
      }).byteLength,
    });

    await expect(
      composition.application.deleteCard({
        context: controlPlaneContext(),
        mutationId: fixtureMutationId('sync-v2-server-delete'),
        cardId: flowMutation.cardId,
        expectedRevision: parseContentRevision(2),
        deletedAt: 1_550,
        synchronizedAt: 1_550,
        limits: paidPersonalVaultLimits,
      }),
    ).resolves.toMatchObject({
      kind: 'deleted',
      receipt: { appliedRevision: 3 },
    });
    await expect(quotaUsage(flowDatabase)).resolves.toMatchObject({
      active_cards: 0,
      plaintext_bytes: 0,
    });

    const beforeDeleteReplay = adapterCalls(
      objects.calls(),
      encryption.calls(),
    );
    await expect(
      composition.application.deleteCard({
        context: controlPlaneContext(),
        mutationId: fixtureMutationId('sync-v2-server-delete'),
        cardId: flowMutation.cardId,
        expectedRevision: parseContentRevision(2),
        deletedAt: 1_550,
        synchronizedAt: 1_550,
        limits: paidPersonalVaultLimits,
      }),
    ).resolves.toMatchObject({ kind: 'deleted' });
    expect(adapterCalls(objects.calls(), encryption.calls())).toEqual(
      beforeDeleteReplay,
    );

    const beforeTombstone = adapterCalls(objects.calls(), encryption.calls());
    const tombstoneResponse = await handler(
      syncRequest([], updated.page.nextCursor),
    );
    const tombstone = decodeSyncV2Response(await tombstoneResponse.json(), []);
    expect(tombstone.changes).toEqual([
      {
        kind: 'card-tombstone',
        sequence: parseSyncSequence(3),
        cardId: flowMutation.cardId,
        revision: 3,
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
      objectKeys: objectKeys([
        encryptedObjectIds.objectKeyB,
        encryptedObjectIds.objectKeyC,
        encryptedObjectIds.objectKeyD,
      ]),
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
    await expect(
      quotaReservation(recoveryDatabase, recoveryMutation.mutationId),
    ).resolves.toMatchObject({ state: 'reserved' });

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
    await expect(
      quotaReservation(recoveryDatabase, recoveryMutation.mutationId),
    ).resolves.toMatchObject({ state: 'committed' });

    await recoveryDatabase
      .prepare(
        `CREATE TRIGGER fail_sync_v2_quota_reserve
         BEFORE INSERT ON vault_quota_reservations
         BEGIN SELECT RAISE(ABORT, 'injected quota reserve failure'); END`,
      )
      .run();
    const reserveFailureMutation = mutation('sync-v2-quota-reserve-failure');
    const beforeReserveFailure = adapterCalls(
      objects.calls(),
      encryption.calls(),
    );
    const reserveFailure = await handler(syncRequest([reserveFailureMutation]));
    expect(reserveFailure.status).toBe(503);
    expect(adapterCalls(objects.calls(), encryption.calls())).toEqual(
      beforeReserveFailure,
    );
    await expect(
      quotaReservation(recoveryDatabase, reserveFailureMutation.mutationId),
    ).resolves.toBeNull();
    await recoveryDatabase
      .prepare('DROP TRIGGER fail_sync_v2_quota_reserve')
      .run();

    await recoveryDatabase
      .prepare(
        `CREATE TRIGGER fail_sync_v2_quota_finalize
         BEFORE UPDATE OF state ON vault_quota_reservations
         BEGIN SELECT RAISE(ABORT, 'injected quota finalize failure'); END`,
      )
      .run();
    const finalizeFailureMutation = mutation('sync-v2-quota-finalize-failure');
    const finalizeFailure = await handler(
      syncRequest([finalizeFailureMutation]),
    );
    expect(finalizeFailure.status).toBe(503);
    await expect(
      quotaReservation(recoveryDatabase, finalizeFailureMutation.mutationId),
    ).resolves.toMatchObject({ state: 'reserved' });
    await recoveryDatabase
      .prepare('DROP TRIGGER fail_sync_v2_quota_finalize')
      .run();
    const beforeFinalizeRetry = adapterCalls(
      objects.calls(),
      encryption.calls(),
    );
    const finalizeRetry = await handler(syncRequest([finalizeFailureMutation]));
    expect(finalizeRetry.status).toBe(200);
    expect(objects.calls().put).toBe(beforeFinalizeRetry.put);
    expect(encryption.calls().encrypt).toBe(beforeFinalizeRetry.encrypt);
    await expect(
      quotaReservation(recoveryDatabase, finalizeFailureMutation.mutationId),
    ).resolves.toMatchObject({ state: 'committed' });
    await expect(quotaUsage(recoveryDatabase)).resolves.toMatchObject({
      active_cards: 2,
    });

    const contentFailureMutation = mutation('sync-v2-content-write-failure');
    objects.failNext('put');
    const contentFailure = await handler(syncRequest([contentFailureMutation]));
    expect(contentFailure.status).toBe(503);
    await expect(
      quotaReservation(recoveryDatabase, contentFailureMutation.mutationId),
    ).resolves.toMatchObject({ state: 'reserved' });
    const contentRetry = await handler(syncRequest([contentFailureMutation]));
    expect(contentRetry.status).toBe(200);
    await expect(
      quotaReservation(recoveryDatabase, contentFailureMutation.mutationId),
    ).resolves.toMatchObject({ state: 'committed' });
    await expect(quotaUsage(recoveryDatabase)).resolves.toMatchObject({
      active_cards: 3,
    });
  });

  it('rejects display and serialized plaintext limits before object storage', async () => {
    const objects = createFakePrivateObjectStorage();
    const encryption = countedEncryption(encryptionFor(controlPlaneContext()));
    const handler = createHandler({
      database: limitsDatabase,
      now: mutableClock(1_500),
      objects,
      encryption: encryption.port,
      cursors: createWebCryptoSyncV2CursorAuthenticator(cursorSecret),
      objectKeys: objectKeys([encryptedObjectIds.objectKeyA]),
      keyring: keyringFor(controlPlaneContext().vaultId),
    });
    const displayMutation: PendingMutation = {
      ...mutation('sync-v2-display-limit'),
      title: 'x'.repeat(1_001),
      body: [],
    };
    const display = await handler(syncRequest([displayMutation]));
    expect(display.status).toBe(413);
    await expect(display.json()).resolves.toEqual({ error: 'card-too-large' });

    const serializedMutation: PendingMutation = {
      ...mutation('sync-v2-serialized-limit'),
      body: Array.from({ length: 300 }, () => ({
        type: 'link' as const,
        targetCardId: fixtureCardId('sync-v2-serialized-limit-target'),
      })),
    };
    const serialized = await handler(syncRequest([serializedMutation]));
    expect(serialized.status).toBe(413);
    await expect(serialized.json()).resolves.toEqual({
      error: 'card-too-large',
    });

    await limitsDatabase
      .prepare(
        `UPDATE vault_quota_usage SET plaintext_bytes = ?
         WHERE account_id = ? AND vault_id = ?`,
      )
      .bind(
        paidPersonalVaultLimits.plaintextBytesPerVault,
        controlPlaneContext().accountId,
        controlPlaneContext().vaultId,
      )
      .run();
    const vaultTotal = await handler(
      syncRequest([mutation('sync-v2-vault-plaintext-limit')]),
    );
    expect(vaultTotal.status).toBe(409);
    await expect(vaultTotal.json()).resolves.toEqual({
      error: 'quota-exceeded',
    });
    expect(objects.calls()).toMatchObject({ get: 0, put: 0 });
    expect(encryption.calls()).toEqual({ encrypt: 0, decrypt: 0 });
    await expect(quotaUsage(limitsDatabase)).resolves.toMatchObject({
      active_cards: 0,
      plaintext_bytes: paidPersonalVaultLimits.plaintextBytesPerVault,
    });
  });

  it('admits only one concurrent create at the 10,000-card boundary', async () => {
    const context = controlPlaneContext();
    const quota = await new D1VaultQuotaLedgerDirectory(
      concurrencyDatabase,
    ).open(context, 1_500);
    if (quota.kind !== 'opened') throw new Error('missing quota scope');
    await concurrencyDatabase
      .prepare(
        `UPDATE vault_quota_usage SET active_cards = 9999
         WHERE account_id = ? AND vault_id = ?`,
      )
      .bind(context.accountId, context.vaultId)
      .run();
    const objects = createFakePrivateObjectStorage();
    const encryption = countedEncryption(encryptionFor(context));
    const handler = createHandler({
      database: concurrencyDatabase,
      now: mutableClock(1_500),
      objects,
      encryption: encryption.port,
      cursors: createWebCryptoSyncV2CursorAuthenticator(cursorSecret),
      objectKeys: objectKeys([
        encryptedObjectIds.objectKeyA,
        encryptedObjectIds.objectKeyB,
      ]),
      keyring: keyringFor(context.vaultId),
    });
    const responses = await Promise.all([
      handler(syncRequest([mutation('sync-v2-card-10000-a')])),
      handler(syncRequest([mutation('sync-v2-card-10000-b')])),
    ]);
    expect(
      responses.map((response) => response.status).sort((a, b) => a - b),
    ).toEqual([200, 409]);
    const rejected = responses.find((response) => response.status === 409);
    if (rejected === undefined) throw new Error('missing quota rejection');
    await expect(rejected.json()).resolves.toEqual({
      error: 'quota-exceeded',
    });
    await expect(quotaUsage(concurrencyDatabase)).resolves.toMatchObject({
      active_cards: 10_000,
    });
    expect(objects.calls().put).toBe(1);
    expect(encryption.calls().encrypt).toBe(1);
  });

  it('preserves concurrent conflicts without increasing active-card quota', async () => {
    const context = controlPlaneContext();
    const objects = createFakePrivateObjectStorage();
    const handler = createHandler({
      database: conflictDatabase,
      now: mutableClock(1_500),
      objects,
      encryption: encryptionFor(context),
      cursors: createWebCryptoSyncV2CursorAuthenticator(cursorSecret),
      objectKeys: objectKeys([
        encryptedObjectIds.objectKeyA,
        encryptedObjectIds.objectKeyB,
      ]),
      keyring: keyringFor(context.vaultId),
    });
    const base = mutation('sync-v2-conflict-base');
    const createdResponse = await handler(syncRequest([base]));
    expect(createdResponse.status).toBe(200);
    const created = decodeSyncV2Response(await createdResponse.json(), [base]);
    const usageBeforeConflict = await quotaUsage(conflictDatabase);
    const concurrent: PendingMutation = {
      ...base,
      mutationId: fixtureMutationId('sync-v2-conflict-concurrent'),
      title: 'Concurrent title',
      body: [{ type: 'text', text: 'Concurrent body' }],
      updatedAt: 1_400,
    };
    const conflictResponse = await handler(
      syncRequest([concurrent], created.page.nextCursor),
    );
    expect(conflictResponse.status).toBe(200);
    const conflict = decodeSyncV2Response(await conflictResponse.json(), [
      concurrent,
    ]);
    expect(conflict.changes).toMatchObject([
      { kind: 'conflict-upsert', conflict: { cardId: base.cardId } },
    ]);
    await expect(quotaUsage(conflictDatabase)).resolves.toEqual(
      usageBeforeConflict,
    );
  });

  it('isolates equal card and mutation identifiers between two Vaults', async () => {
    const contextA = vaultContentContext('a');
    const contextB = vaultContentContext('b');
    const objects = createFakePrivateObjectStorage();
    const requestValue = encodeSyncV2Request({
      deviceId,
      cursor: null,
      mutations: [flowMutation],
    });
    const applicationRequest = decodeSyncV2Request(requestValue);
    const requestBytes = parseQuotaByteCount(
      new TextEncoder().encode(JSON.stringify(requestValue)).byteLength,
    );
    const applicationA = createComposition({
      database: tenantsDatabase,
      now: mutableClock(1_500),
      objects,
      encryption: encryptionFor(contextA),
      cursors: createWebCryptoSyncV2CursorAuthenticator(cursorSecret),
      objectKeys: objectKeys([encryptedObjectIds.objectKeyA]),
      keyring: keyringFor(contextA.vaultId),
    }).application;
    const applicationB = createComposition({
      database: tenantsDatabase,
      now: mutableClock(1_500),
      objects,
      encryption: encryptionFor(contextB),
      cursors: createWebCryptoSyncV2CursorAuthenticator(cursorSecret),
      objectKeys: objectKeys([encryptedObjectIds.objectKeyB]),
      keyring: keyringFor(contextB.vaultId),
    }).application;
    const [resultA, resultB] = await Promise.all([
      applicationA.synchronize({
        context: contextA,
        request: applicationRequest,
        synchronizedAt: 1_500,
        requestBytes,
        limits: paidPersonalVaultLimits,
      }),
      applicationB.synchronize({
        context: contextB,
        request: applicationRequest,
        synchronizedAt: 1_500,
        requestBytes,
        limits: paidPersonalVaultLimits,
      }),
    ]);
    expect(resultA.kind).toBe('synchronized');
    expect(resultB.kind).toBe('synchronized');
    await expect(quotaUsage(tenantsDatabase, contextA)).resolves.toMatchObject({
      active_cards: 1,
    });
    await expect(quotaUsage(tenantsDatabase, contextB)).resolves.toMatchObject({
      active_cards: 1,
    });
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

async function provisionTwoVaults(database: TestDatabase): Promise<void> {
  const controlPlane = new D1IdentityVaultControlPlane(database);
  const content = new D1VaultContentDirectory(database, controlPlane);
  for (const account of ['a', 'b'] as const) {
    const context = vaultContentContext(account);
    await controlPlane.provisionPersonalAccount(
      personalAccountProvision(account),
    );
    await content.assignPartition(context, {
      partitionId: vaultContentIds.partitionHot,
      updatedAt: 1_000,
    });
  }
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
  return createComposition(input).handler;
}

function createComposition(input: {
  readonly database: TestDatabase;
  readonly now: ReturnType<typeof mutableClock>;
  readonly objects: ReturnType<typeof createFakePrivateObjectStorage>;
  readonly encryption: EnvelopeEncryptionService;
  readonly cursors: ReturnType<typeof createWebCryptoSyncV2CursorAuthenticator>;
  readonly objectKeys: OpaqueObjectKeyGeneratorPort;
  readonly keyring: unknown;
}) {
  return createD1SyncV2Composition({
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
    quotaReservationReconcileDelayMs: 60_000,
  });
}

async function quotaUsage(
  database: TestDatabase,
  context: VaultContext = controlPlaneContext(),
): Promise<unknown> {
  return database
    .prepare(
      `SELECT active_cards, plaintext_bytes FROM vault_quota_usage
       WHERE account_id = ? AND vault_id = ?`,
    )
    .bind(context.accountId, context.vaultId)
    .first();
}

async function quotaReservation(
  database: TestDatabase,
  mutationId: PendingMutation['mutationId'],
): Promise<unknown> {
  return database
    .prepare(
      `SELECT state FROM vault_quota_reservations
       WHERE account_id = ? AND vault_id = ? AND reservation_id = ?`,
    )
    .bind(
      controlPlaneContext().accountId,
      controlPlaneContext().vaultId,
      mutationId,
    )
    .first();
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
