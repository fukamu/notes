import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import {
  notesDatabaseName,
  type IndexedDbNotesScope,
} from '@/lib/application/notes-database-scope';
import { browserIdGenerator } from '@/lib/client/id-generator';
import { invariant } from '@/lib/shared/invariant';
import {
  clearNotesDatabaseForTests,
  createIndexedDbNotesRepository,
  createIndexedDbSyncV2ReplicaRepository,
  deleteNotesDatabase,
  openNotesDatabase,
  verifyNotesDatabaseDeleted,
} from '@/lib/storage/indexed-db';
import { encodeStoredCard, encodeStoredConflict } from '@/lib/storage/records';
import type { PendingMutation } from '@/lib/domain/types';
import type { SyncV2CommitPlan } from '@/lib/sync/v2-page-application';
import { initialSyncV2Checkpoint } from '@/lib/sync/v2-replica';
import {
  parseSyncSequence,
  parseSyncV2Cursor,
  type SyncV2Change,
} from '@/lib/sync/v2-protocol';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const vaultScopeA: VaultNotesScope = {
  kind: 'vault',
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

const vaultScopeB: VaultNotesScope = {
  kind: 'vault',
  accountId: sessionFixtureIds.otherAccountId,
  vaultId: sessionFixtureIds.otherVaultId,
  sessionId: sessionFixtureIds.nextSessionId,
  sessionEpoch: sessionFixtureIds.nextEpoch,
};

const committedCursor = parseSyncV2Cursor(
  'sync.v2.indexed-db.committed.cccccccccccccccccccccccccccccccc',
);

async function transactionDone(transaction: IDBTransaction): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), {
      once: true,
    });
    transaction.addEventListener('error', () => reject(transaction.error), {
      once: true,
    });
  });
}

async function putRaw(
  storeName: string,
  value: unknown,
  scope: IndexedDbNotesScope = vaultScopeA,
): Promise<void> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
}

async function getRaw(
  storeName: string,
  scope: IndexedDbNotesScope = vaultScopeA,
): Promise<unknown[]> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction(storeName, 'readonly');
  const request = transaction.objectStore(storeName).getAll();
  const result = await new Promise<unknown[]>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    });
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    });
  });
  await transactionDone(transaction);
  return result;
}

async function createVersionOneDatabase(
  scope: VaultNotesScope,
  cardValue: unknown,
): Promise<void> {
  const request = indexedDB.open(notesDatabaseName(scope), 1);
  request.addEventListener('upgradeneeded', () => {
    const database = request.result;
    database.createObjectStore('cards', { keyPath: 'id' });
    database.createObjectStore('mutations', { keyPath: 'cardId' });
    database.createObjectStore('conflicts', { keyPath: 'id' });
    database.createObjectStore('meta', { keyPath: 'key' });
  });
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    });
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    });
  });
  const transaction = database.transaction('cards', 'readwrite');
  transaction.objectStore('cards').put(cardValue);
  await transactionDone(transaction);
  database.close();
}

function commitPlan(input?: {
  readonly includeConflict?: boolean;
  readonly sentMutation?: PendingMutation;
}): SyncV2CommitPlan {
  const fixture = createCompatibilityFixture();
  const sentMutation = input?.sentMutation ?? fixture.mutation;
  const serverCard = fixture.response.cards[0];
  invariant(serverCard, 'Server card fixture is missing');
  const changes: SyncV2Change[] = [
    {
      kind: 'card-upsert',
      sequence: parseSyncSequence(1),
      card: serverCard,
    },
  ];
  if (input?.includeConflict === true) {
    changes.push({
      kind: 'conflict-upsert',
      sequence: parseSyncSequence(2),
      conflict: fixture.conflict,
    });
  }
  return {
    previousCheckpoint: initialSyncV2Checkpoint(),
    nextCheckpoint: {
      cursor: committedCursor,
      highWatermark: parseSyncSequence(changes.length),
    },
    changes,
    receipts: [
      {
        mutationId: sentMutation.mutationId,
        cardId: sentMutation.cardId,
        appliedRevision: 2,
      },
    ],
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    clearNotesDatabaseForTests(vaultScopeA),
    clearNotesDatabaseForTests(vaultScopeB),
  ]);
});

describe('Sync v2 IndexedDB replica repository', () => {
  it('additively upgrades a v1 Vault database and retains its records', async () => {
    const fixture = createCompatibilityFixture();
    const card = fixture.cards[0];
    invariant(card, 'Card fixture is missing');
    await createVersionOneDatabase(vaultScopeA, encodeStoredCard(card));

    const database = await openNotesDatabase(vaultScopeA);
    expect(database.version).toBe(2);
    expect(database.objectStoreNames.contains('sync-v2')).toBe(true);
    const notes = createIndexedDbNotesRepository(
      vaultScopeA,
      browserIdGenerator,
    );
    await expect(notes.loadCards()).resolves.toEqual([card]);
    await expect(
      createIndexedDbSyncV2ReplicaRepository(vaultScopeA).loadCheckpoint(),
    ).resolves.toEqual(initialSyncV2Checkpoint());
  });

  it('commits cards, conflicts, receipt acknowledgement, and checkpoint atomically', async () => {
    const fixture = createCompatibilityFixture();
    const card = fixture.cards[0];
    invariant(card, 'Card fixture is missing');
    const notes = createIndexedDbNotesRepository(
      vaultScopeA,
      browserIdGenerator,
    );
    const sent = await notes.persistCardAndMutation(card);
    const replica = createIndexedDbSyncV2ReplicaRepository(vaultScopeA);
    const plan = commitPlan({ includeConflict: true, sentMutation: sent });

    await expect(replica.applyCommit(plan, [sent])).resolves.toMatchObject({
      kind: 'applied',
      checkpoint: plan.nextCheckpoint,
    });
    await expect(notes.loadPendingMutations()).resolves.toEqual([]);
    await expect(notes.loadCards()).resolves.toEqual([
      expect.objectContaining({
        id: card.id,
        displayId: { kind: 'official', value: 1 },
        serverRevision: 2,
      }),
    ]);
    await expect(notes.loadConflicts()).resolves.toEqual([fixture.conflict]);
    await expect(replica.loadCheckpoint()).resolves.toEqual(
      plan.nextCheckpoint,
    );
    await expect(replica.applyCommit(plan, [sent])).resolves.toMatchObject({
      kind: 'already-applied',
      checkpoint: plan.nextCheckpoint,
    });
  });

  it('keeps a newer saved edit when its predecessor acknowledgement commits later', async () => {
    const fixture = createCompatibilityFixture();
    const card = fixture.cards[0];
    invariant(card, 'Card fixture is missing');
    const notes = createIndexedDbNotesRepository(
      vaultScopeA,
      browserIdGenerator,
    );
    const sent = await notes.persistCardAndMutation(card);
    const edited = {
      ...card,
      title: 'continued local title',
      localRevision: card.localRevision + 1,
      updatedAt: card.updatedAt + 1,
    };
    const newer = await notes.persistCardAndMutation(edited);
    const replica = createIndexedDbSyncV2ReplicaRepository(vaultScopeA);

    await expect(
      replica.applyCommit(commitPlan({ sentMutation: sent }), [sent]),
    ).resolves.toMatchObject({ kind: 'applied' });

    await expect(notes.loadCards()).resolves.toEqual([
      expect.objectContaining({
        id: edited.id,
        title: edited.title,
        localRevision: edited.localRevision,
        serverRevision: 2,
      }),
    ]);
    await expect(notes.loadPendingMutations()).resolves.toEqual([
      expect.objectContaining({
        mutationId: newer.mutationId,
        title: edited.title,
        baseServerRevision: 2,
      }),
    ]);
  });

  it('rolls back every replica write when the checkpoint write fails', async () => {
    const fixture = createCompatibilityFixture();
    const card = fixture.cards[0];
    invariant(card, 'Card fixture is missing');
    const notes = createIndexedDbNotesRepository(
      vaultScopeA,
      browserIdGenerator,
    );
    const sent = await notes.persistCardAndMutation(card);
    await putRaw('conflicts', encodeStoredConflict(fixture.conflict));
    const replica = createIndexedDbSyncV2ReplicaRepository(vaultScopeA);
    const cardsBefore = await notes.loadCards();
    const mutationsBefore = await notes.loadPendingMutations();
    const conflictsBefore = await notes.loadConflicts();
    const originalPut: unknown = Object.getOwnPropertyDescriptor(
      IDBObjectStore.prototype,
      'put',
    )?.value;
    if (typeof originalPut !== 'function') {
      throw new Error('IDBObjectStore.put is unavailable');
    }
    const putSpy = vi
      .spyOn(IDBObjectStore.prototype, 'put')
      .mockImplementation(function (
        this: IDBObjectStore,
        value: unknown,
        key?: IDBValidKey,
      ) {
        if (this.name === 'sync-v2') {
          throw new Error('injected checkpoint failure');
        }
        const result: unknown = Reflect.apply(
          originalPut,
          this,
          key === undefined ? [value] : [value, key],
        );
        if (!(result instanceof IDBRequest)) {
          throw new Error('IDBObjectStore.put returned an invalid request');
        }
        // fake-indexeddb erases the overload result; the runtime guard above
        // and IDBObjectStore.put contract establish the returned key request.
        return result as IDBRequest<IDBValidKey>;
      });

    try {
      await expect(
        replica.applyCommit(commitPlan({ sentMutation: sent }), [sent]),
      ).rejects.toThrow('injected checkpoint failure');
    } finally {
      putSpy.mockRestore();
    }

    await expect(notes.loadCards()).resolves.toEqual(cardsBefore);
    await expect(notes.loadPendingMutations()).resolves.toEqual(
      mutationsBefore,
    );
    await expect(notes.loadConflicts()).resolves.toEqual(conflictsBefore);
    await expect(replica.loadCheckpoint()).resolves.toEqual(
      initialSyncV2Checkpoint(),
    );
  });

  it('fully separates identical CardIds and checkpoints across Vaults', async () => {
    const fixture = createCompatibilityFixture();
    const card = fixture.cards[0];
    invariant(card, 'Card fixture is missing');
    const notesA = createIndexedDbNotesRepository(
      vaultScopeA,
      browserIdGenerator,
    );
    const notesB = createIndexedDbNotesRepository(
      vaultScopeB,
      browserIdGenerator,
    );
    const sentA = await notesA.persistCardAndMutation({
      ...card,
      title: 'Vault A',
    });
    await notesB.persistCardAndMutation({ ...card, title: 'Vault B' });
    const replicaA = createIndexedDbSyncV2ReplicaRepository(vaultScopeA);
    const replicaB = createIndexedDbSyncV2ReplicaRepository(vaultScopeB);

    const plan = commitPlan({ sentMutation: sentA });
    await replicaA.applyCommit(plan, [sentA]);

    await expect(replicaA.loadCheckpoint()).resolves.toEqual(
      plan.nextCheckpoint,
    );
    await expect(replicaB.loadCheckpoint()).resolves.toEqual(
      initialSyncV2Checkpoint(),
    );
    await expect(notesB.loadCards()).resolves.toEqual([
      expect.objectContaining({ id: compatibilityIds.cardA, title: 'Vault B' }),
    ]);
    await expect(notesB.loadPendingMutations()).resolves.toHaveLength(1);
  });

  it('rejects a corrupt stored checkpoint without rewriting local state', async () => {
    const fixture = createCompatibilityFixture();
    const card = fixture.cards[0];
    invariant(card, 'Card fixture is missing');
    const notes = createIndexedDbNotesRepository(
      vaultScopeA,
      browserIdGenerator,
    );
    const sent = await notes.persistCardAndMutation(card);
    const corruptCheckpoint = {
      key: 'checkpoint',
      cursor: 'not a valid cursor',
      highWatermark: 0,
    };
    await putRaw('sync-v2', corruptCheckpoint);
    const cardsBefore = await notes.loadCards();
    const mutationsBefore = await notes.loadPendingMutations();
    const replica = createIndexedDbSyncV2ReplicaRepository(vaultScopeA);

    await expect(replica.loadCheckpoint()).rejects.toThrow(
      'IndexedDB Sync v2 checkpoint',
    );
    await expect(
      replica.applyCommit(commitPlan({ sentMutation: sent }), [sent]),
    ).rejects.toThrow('IndexedDB Sync v2 checkpoint');
    await expect(notes.loadCards()).resolves.toEqual(cardsBefore);
    await expect(notes.loadPendingMutations()).resolves.toEqual(
      mutationsBefore,
    );
    expect(await getRaw('sync-v2')).toEqual([corruptCheckpoint]);
  });

  it('does not recreate a deleted Vault merely by constructing the scope-bound port', async () => {
    await expect(deleteNotesDatabase(vaultScopeA)).resolves.toEqual({
      kind: 'deleted',
    });
    const replica = createIndexedDbSyncV2ReplicaRepository(vaultScopeA);
    expect(replica.scope).toBe(vaultScopeA);
    await expect(verifyNotesDatabaseDeleted(vaultScopeA)).resolves.toEqual({
      kind: 'verified-deleted',
    });
  });
});
