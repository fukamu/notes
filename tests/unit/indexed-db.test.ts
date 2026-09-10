import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCardId, isUuidV7 } from '@/lib/domain/id';
import type { CardRecord } from '@/lib/domain/types';
import { invariant } from '@/lib/shared/invariant';
import {
  applySyncResponse,
  clearNotesDatabaseForTests,
  loadCards,
  loadPendingMutations,
  loadConflicts,
  loadOrCreateDeviceId,
  openNotesDatabase,
  persistCardAndMutation,
} from '@/lib/storage/indexed-db';
import {
  encodeStoredConflict,
  encodeStoredMutation,
} from '@/lib/storage/records';
import {
  compatibilityIds,
  createCompatibilityFixture,
} from '@/tests/fixtures/compatibility';

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

async function putRaw(storeName: string, value: unknown): Promise<void> {
  const database = await openNotesDatabase();
  const transaction = database.transaction(storeName, 'readwrite');
  transaction.objectStore(storeName).put(value);
  await transactionDone(transaction);
}

async function getRaw(storeName: string): Promise<unknown[]> {
  const database = await openNotesDatabase();
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
  await clearNotesDatabaseForTests();
});

describe('local persistence', () => {
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
        return request;
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
