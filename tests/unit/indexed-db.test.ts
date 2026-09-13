import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserIdGenerator, createCardId } from '@/lib/client/id-generator';
import {
  LEGACY_NOTES_SCOPE,
  type IdGenerator,
} from '@/lib/application/notes-runtime';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import {
  notesDatabaseName,
  type IndexedDbNotesScope,
} from '@/lib/application/notes-database-scope';
import { isUuidV7, parseDeviceId, parseMutationId } from '@/lib/domain/id';
import type { CardRecord } from '@/lib/domain/types';
import { invariant } from '@/lib/shared/invariant';
import {
  clearNotesDatabaseForTests,
  closeNotesDatabase,
  createIndexedDbNotesRepository,
  deleteNotesDatabase,
  openNotesDatabase,
} from '@/lib/storage/indexed-db';
import {
  encodeStoredConflict,
  encodeStoredMutation,
} from '@/lib/storage/records';
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

const vaultIdGeneratorB: IdGenerator = {
  createCardId: () => compatibilityIds.cardB,
  createMutationId: () =>
    parseMutationId('01991f20-61d2-7000-8000-000000000015'),
  createDeviceId: () => parseDeviceId('01991f20-61d2-7000-8000-000000000014'),
};

const {
  applySyncResponse,
  loadCards,
  loadConflicts,
  loadOrCreateDeviceId,
  loadPendingMutations,
  persistCardAndMutation,
} = createIndexedDbNotesRepository(LEGACY_NOTES_SCOPE, browserIdGenerator);

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
  scope: IndexedDbNotesScope = LEGACY_NOTES_SCOPE,
): Promise<void> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
}

async function getRaw(
  storeName: string,
  scope: IndexedDbNotesScope = LEGACY_NOTES_SCOPE,
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

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all([
    clearNotesDatabaseForTests(LEGACY_NOTES_SCOPE),
    clearNotesDatabaseForTests(vaultScopeA),
    clearNotesDatabaseForTests(vaultScopeB),
  ]);
});

describe('local persistence', () => {
  it('fully separates identical CardIds across two Vault repositories', async () => {
    const fixture = createCompatibilityFixture();
    const original = fixture.cards[0];
    invariant(original, 'Compatibility card is missing');
    const repositoryA = createIndexedDbNotesRepository(
      vaultScopeA,
      browserIdGenerator,
    );
    const repositoryB = createIndexedDbNotesRepository(
      vaultScopeB,
      vaultIdGeneratorB,
    );
    const cardA = { ...original, title: 'Vault A content' };
    const cardB = { ...original, title: 'Vault B content' };

    await Promise.all([
      repositoryA.persistCardAndMutation(cardA),
      repositoryB.persistCardAndMutation(cardB),
    ]);
    await putRaw(
      'conflicts',
      encodeStoredConflict(fixture.conflict),
      vaultScopeA,
    );

    await expect(repositoryA.loadCards()).resolves.toEqual([cardA]);
    await expect(repositoryB.loadCards()).resolves.toEqual([cardB]);
    await expect(repositoryA.loadPendingMutations()).resolves.toMatchObject([
      { cardId: original.id, title: 'Vault A content' },
    ]);
    await expect(repositoryB.loadPendingMutations()).resolves.toMatchObject([
      { cardId: original.id, title: 'Vault B content' },
    ]);
    await expect(repositoryA.loadConflicts()).resolves.toEqual([
      fixture.conflict,
    ]);
    await expect(repositoryB.loadConflicts()).resolves.toEqual([]);
    await expect(repositoryA.loadOrCreateDeviceId()).resolves.not.toBe(
      vaultIdGeneratorB.createDeviceId(),
    );
    await expect(repositoryB.loadOrCreateDeviceId()).resolves.toBe(
      vaultIdGeneratorB.createDeviceId(),
    );
  });

  it('reuses connections per database and can close and reopen one Vault', async () => {
    const first = await openNotesDatabase(vaultScopeA);
    const sameVault = await openNotesDatabase({
      ...vaultScopeA,
      sessionId: sessionFixtureIds.nextSessionId,
      sessionEpoch: sessionFixtureIds.nextEpoch,
    });
    const otherVault = await openNotesDatabase(vaultScopeB);

    expect(sameVault).toBe(first);
    expect(otherVault).not.toBe(first);
    await expect(closeNotesDatabase(vaultScopeA)).resolves.toEqual({
      kind: 'closed',
    });
    await expect(closeNotesDatabase(vaultScopeA)).resolves.toEqual({
      kind: 'not-open',
    });
    await expect(openNotesDatabase(vaultScopeA)).resolves.not.toBe(first);
  });

  it('reports blocked deletion instead of treating it as success', async () => {
    const unmanagedRequest = indexedDB.open(notesDatabaseName(vaultScopeA), 1);
    const unmanagedDatabase = await new Promise<IDBDatabase>(
      (resolve, reject) => {
        unmanagedRequest.addEventListener(
          'success',
          () => resolve(unmanagedRequest.result),
          { once: true },
        );
        unmanagedRequest.addEventListener(
          'error',
          () => reject(unmanagedRequest.error),
          { once: true },
        );
      },
    );

    await expect(deleteNotesDatabase(vaultScopeA)).resolves.toEqual({
      kind: 'blocked',
    });
    unmanagedDatabase.close();
    await expect(deleteNotesDatabase(vaultScopeA)).resolves.toEqual({
      kind: 'deleted',
    });
  });

  it('normalizes a synchronous IndexedDB deletion failure', async () => {
    vi.spyOn(indexedDB, 'deleteDatabase').mockImplementation(() => {
      throw new Error('injected delete failure');
    });
    await expect(deleteNotesDatabase(vaultScopeA)).resolves.toEqual({
      kind: 'failed',
      reason: 'request-threw',
    });
  });

  it('uses injected identifiers while keeping the fixed legacy database', async () => {
    const fixture = createCompatibilityFixture();
    const idGenerator: IdGenerator = {
      createCardId: () => compatibilityIds.cardB,
      createMutationId: () => compatibilityIds.mutation,
      createDeviceId: () => compatibilityIds.device,
    };
    const injectedRepository = createIndexedDbNotesRepository(
      LEGACY_NOTES_SCOPE,
      idGenerator,
    );
    const card = fixture.cards[0];
    invariant(card, 'Compatibility card is missing');

    expect(injectedRepository.scope).toBe(LEGACY_NOTES_SCOPE);
    await expect(injectedRepository.loadOrCreateDeviceId()).resolves.toBe(
      compatibilityIds.device,
    );
    await expect(
      injectedRepository.persistCardAndMutation(card),
    ).resolves.toMatchObject({ mutationId: compatibilityIds.mutation });
  });

  it('persists an empty offline card with UUIDv7 and provisional id', async () => {
    const id = createCardId();
    const card: CardRecord = {
      id,
      displayId: { kind: 'provisional', value: 12 },
      title: '',
      body: [],
      createdAt: 1,
      updatedAt: 1,
      localRevision: 1,
      serverRevision: null,
    };
    await persistCardAndMutation(card);
    const [stored] = await loadCards();
    invariant(stored, 'Stored card was not loaded');
    expect(stored).toEqual(card);
    expect(isUuidV7(stored.id)).toBe(true);
    expect(await loadPendingMutations()).toHaveLength(1);
  });

  it('coalesces repeated unsent saves per card without duplicating it', async () => {
    const card: CardRecord = {
      id: createCardId(),
      displayId: { kind: 'provisional', value: 1 },
      title: '一回目',
      body: [],
      createdAt: 1,
      updatedAt: 1,
      localRevision: 1,
      serverRevision: null,
    };
    await persistCardAndMutation(card);
    await persistCardAndMutation({
      ...card,
      title: '二回目',
      localRevision: 2,
      updatedAt: 2,
    });
    expect(await loadCards()).toHaveLength(1);
    const [stored] = await loadCards();
    invariant(stored, 'Stored card was not loaded');
    expect(stored.title).toBe('二回目');
    expect(await loadPendingMutations()).toHaveLength(1);
  });

  it('rebases an edit saved while a sync request is in flight', async () => {
    const card: CardRecord = {
      id: createCardId(),
      displayId: { kind: 'official', value: 7 },
      title: '端末の新しい編集',
      body: [{ type: 'text', text: '失わない本文' }],
      createdAt: 1,
      updatedAt: 3,
      localRevision: 3,
      serverRevision: 1,
    };
    await persistCardAndMutation(card);

    const result = await applySyncResponse(
      {
        cards: [
          {
            id: card.id,
            officialDisplayId: 7,
            title: '同期要求時の内容',
            body: [],
            createdAt: 1,
            updatedAt: 2,
            revision: 2,
          },
        ],
        conflicts: [],
        acknowledgedMutationIds: [],
      },
      [],
    );

    const [storedCard] = result.cards;
    const [storedMutation] = await loadPendingMutations();
    invariant(storedCard, 'Synchronized card was not loaded');
    invariant(storedMutation, 'Pending mutation was not loaded');
    expect(storedCard.title).toBe('端末の新しい編集');
    expect(storedCard.body).toEqual([{ type: 'text', text: '失わない本文' }]);
    expect(storedMutation.baseServerRevision).toBe(2);
  });

  it('rejects corrupt store records without deleting or rewriting raw data', async () => {
    const corruptCard = {
      id: 'not-a-uuid',
      displayId: { kind: 'official', value: 1 },
      title: '壊れたカード',
      body: [],
      createdAt: 1,
      updatedAt: 1,
      localRevision: 1,
      serverRevision: 1,
    };
    await putRaw('cards', corruptCard);
    await expect(loadCards()).rejects.toThrow('IndexedDB cards');
    expect(await getRaw('cards')).toEqual([corruptCard]);

    const fixture = createCompatibilityFixture();
    const corruptMutation = {
      ...encodeStoredMutation(fixture.mutation),
      mutationId: 'broken-mutation-id',
    };
    await putRaw('mutations', corruptMutation);
    await expect(loadPendingMutations()).rejects.toThrow('IndexedDB mutations');
    expect(await getRaw('mutations')).toEqual([corruptMutation]);

    const corruptConflict = {
      ...encodeStoredConflict(fixture.conflict),
      serverRevision: -1,
    };
    await putRaw('conflicts', corruptConflict);
    await expect(loadConflicts()).rejects.toThrow('IndexedDB conflicts');
    expect(await getRaw('conflicts')).toEqual([corruptConflict]);
  });

  it('regenerates only a missing device ID and preserves an invalid meta record', async () => {
    const generated = await loadOrCreateDeviceId();
    expect(isUuidV7(generated)).toBe(true);

    await putRaw('meta', { key: 'deviceId', value: 'broken-device-id' });
    await expect(loadOrCreateDeviceId()).rejects.toThrow('IndexedDB meta');
    expect(await getRaw('meta')).toEqual([
      { key: 'deviceId', value: 'broken-device-id' },
    ]);
  });

  it('does not mutate IndexedDB when a later field of a 2xx payload is malformed', async () => {
    const fixture = createCompatibilityFixture();
    const fixtureCard = fixture.cards[0];
    invariant(fixtureCard, 'Compatibility card is missing');
    const sent = await persistCardAndMutation(fixtureCard);
    const cardsBefore = await loadCards();
    const mutationsBefore = await loadPendingMutations();

    await expect(
      applySyncResponse(
        {
          cards: null,
          conflicts: fixture.response.conflicts,
          acknowledgedMutationIds: [sent.mutationId],
        },
        [sent],
      ),
    ).rejects.toThrow('SyncResponse');

    expect(await loadCards()).toEqual(cardsBefore);
    expect(await loadPendingMutations()).toEqual(mutationsBefore);
  });

  it('preserves pending mutations for unsent or duplicate acknowledgements', async () => {
    const fixture = createCompatibilityFixture();
    const fixtureCard = fixture.cards[0];
    invariant(fixtureCard, 'Compatibility card is missing');
    const sent = await persistCardAndMutation(fixtureCard);
    const validCard = {
      id: fixtureCard.id,
      officialDisplayId: 1,
      title: 'server',
      body: [],
      createdAt: 1,
      updatedAt: 2,
      revision: 2,
    };

    for (const acknowledgedMutationIds of [
      [compatibilityIds.mutation],
      [sent.mutationId, sent.mutationId],
    ]) {
      await expect(
        applySyncResponse(
          { cards: [validCard], conflicts: [], acknowledgedMutationIds },
          [sent],
        ),
      ).rejects.toThrow();
      expect(await loadPendingMutations()).toEqual([sent]);
    }
  });

  it('aborts all writes when applying a validated response throws', async () => {
    const fixture = createCompatibilityFixture();
    const fixtureCard = fixture.cards[0];
    invariant(fixtureCard, 'Compatibility card is missing');
    const originalCard = { ...fixtureCard, body: [] };
    const sent = await persistCardAndMutation(originalCard);
    await putRaw('conflicts', encodeStoredConflict(fixture.conflict));
    const cardsBefore = await loadCards();
    const mutationsBefore = await loadPendingMutations();
    const conflictsBefore = await loadConflicts();
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
        if (this.name === 'conflicts')
          throw new Error('injected apply failure');
        const request: unknown = Reflect.apply(
          originalPut,
          this,
          key === undefined ? [value] : [value, key],
        );
        if (!(request instanceof IDBRequest)) {
          throw new Error('IDBObjectStore.put returned an invalid request');
        }
        // fake-indexeddb erases the overload result to `any`; the runtime class
        // guard above and IDBObjectStore.put contract establish this key result.
        return request as IDBRequest<IDBValidKey>;
      });

    try {
      await expect(
        applySyncResponse(
          {
            cards: [
              {
                id: originalCard.id,
                officialDisplayId: 1,
                title: 'server update',
                body: [],
                createdAt: originalCard.createdAt,
                updatedAt: originalCard.updatedAt + 1,
                revision: 2,
              },
            ],
            conflicts: [fixture.conflict],
            acknowledgedMutationIds: [sent.mutationId],
          },
          [sent],
        ),
      ).rejects.toThrow('injected apply failure');
    } finally {
      putSpy.mockRestore();
    }

    expect(await loadCards()).toEqual(cardsBefore);
    expect(await loadPendingMutations()).toEqual(mutationsBefore);
    expect(await loadConflicts()).toEqual(conflictsBefore);
  });
});
