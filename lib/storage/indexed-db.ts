import {
  createDeviceId,
  createMutationId,
  type ConflictId,
  type DeviceId,
} from '@/lib/domain/id';
import { reconcileProvisionalDisplayIds } from '@/lib/domain/display-id';
import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '@/lib/domain/types';
import { decodeSyncResponse } from '@/lib/sync/protocol';
import {
  decodeStoredCards,
  decodeStoredConflicts,
  decodeStoredMeta,
  decodeStoredMutations,
  encodeStoredCard,
  encodeStoredConflict,
  encodeStoredMeta,
  encodeStoredMutation,
} from '@/lib/storage/records';

const DATABASE_NAME = 'fukamu-notes';
const DATABASE_VERSION = 1;

let databasePromise: Promise<IDBDatabase> | undefined;

function requestResult<T>(request: IDBRequest<T>): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    });
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    });
  });
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('abort', () => reject(transaction.error), {
      once: true,
    });
    transaction.addEventListener('error', () => reject(transaction.error), {
      once: true,
    });
  });
}

export function openNotesDatabase(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener('upgradeneeded', () => {
      const database = request.result;
      if (!database.objectStoreNames.contains('cards')) {
        database.createObjectStore('cards', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('mutations')) {
        database.createObjectStore('mutations', { keyPath: 'cardId' });
      }
      if (!database.objectStoreNames.contains('conflicts')) {
        database.createObjectStore('conflicts', { keyPath: 'id' });
      }
      if (!database.objectStoreNames.contains('meta')) {
        database.createObjectStore('meta', { keyPath: 'key' });
      }
    });
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    });
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    });
  });
  return databasePromise;
}

export async function loadCards(): Promise<CardRecord[]> {
  const database = await openNotesDatabase();
  const transaction = database.transaction('cards', 'readonly');
  return decodeStoredCards(
    await requestResult(transaction.objectStore('cards').getAll()),
  );
}

export async function loadPendingMutations(): Promise<PendingMutation[]> {
  const database = await openNotesDatabase();
  const transaction = database.transaction('mutations', 'readonly');
  return decodeStoredMutations(
    await requestResult(transaction.objectStore('mutations').getAll()),
  );
}

export async function loadConflicts(): Promise<ConflictRecord[]> {
  const database = await openNotesDatabase();
  const transaction = database.transaction('conflicts', 'readonly');
  return decodeStoredConflicts(
    await requestResult(transaction.objectStore('conflicts').getAll()),
  );
}

export async function loadOrCreateDeviceId(): Promise<DeviceId> {
  const database = await openNotesDatabase();
  const transaction = database.transaction('meta', 'readwrite');
  const store = transaction.objectStore('meta');
  const existing = await requestResult(store.get('deviceId'));
  if (existing !== undefined) return decodeStoredMeta(existing).value;
  const value = createDeviceId();
  store.put(encodeStoredMeta(value));
  await transactionComplete(transaction);
  return value;
}

export async function persistCardAndMutation(
  card: CardRecord,
  options:
    | { kind: 'upsert' }
    | { kind: 'resolve'; conflictIds: [ConflictId, ...ConflictId[]] } = {
    kind: 'upsert',
  },
): Promise<PendingMutation> {
  const database = await openNotesDatabase();
  const baseServerRevision = card.serverRevision;
  const base = {
    mutationId: createMutationId(),
    cardId: card.id,
    title: card.title,
    body: card.body,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
  const mutation: PendingMutation =
    options.kind === 'resolve'
      ? (() => {
          if (baseServerRevision === null) {
            throw new Error(
              'Cannot resolve a conflict without a server revision',
            );
          }
          return {
            ...base,
            kind: options.kind,
            baseServerRevision,
            conflictIds: options.conflictIds,
          };
        })()
      : {
          ...base,
          kind: options.kind,
          baseServerRevision,
          conflictIds: [],
        };
  const transaction = database.transaction(['cards', 'mutations'], 'readwrite');
  transaction.objectStore('cards').put(encodeStoredCard(card));
  transaction.objectStore('mutations').put(encodeStoredMutation(mutation));
  await transactionComplete(transaction);
  return mutation;
}

export async function applySyncResponse(
  input: unknown,
  sentMutations: PendingMutation[],
): Promise<{ cards: CardRecord[]; conflicts: ConflictRecord[] }> {
  // Decode the complete response and its cross-field invariants before opening
  // a readwrite transaction. Invalid 2xx payloads cannot delete mutations.
  const response = decodeSyncResponse(input, sentMutations);
  const database = await openNotesDatabase();
  const transaction = database.transaction(
    ['cards', 'mutations', 'conflicts'],
    'readwrite',
  );
  const cardStore = transaction.objectStore('cards');
  const mutationStore = transaction.objectStore('mutations');
  const conflictStore = transaction.objectStore('conflicts');
  const completion = transactionComplete(transaction);

  try {
    const localCardsRequest = cardStore.getAll();
    const currentMutationsRequest = mutationStore.getAll();
    const [localCardsInput, currentMutationsInput] = await Promise.all([
      requestResult(localCardsRequest),
      requestResult(currentMutationsRequest),
    ]);
    const localCards = decodeStoredCards(localCardsInput);
    const currentMutations = decodeStoredMutations(currentMutationsInput);
    const acknowledged = new Set(response.acknowledgedMutationIds);
    const sentByCard = new Map(
      sentMutations.map((mutation) => [mutation.cardId, mutation]),
    );
    const pendingByCard = new Map(
      currentMutations.map((mutation) => [mutation.cardId, mutation]),
    );

    for (const mutation of currentMutations) {
      if (acknowledged.has(mutation.mutationId)) {
        mutationStore.delete(mutation.cardId);
        pendingByCard.delete(mutation.cardId);
      }
    }

    const merged = new Map(localCards.map((card) => [card.id, card]));
    for (const serverCard of response.cards) {
      const local = merged.get(serverCard.id);
      const pending = pendingByCard.get(serverCard.id);
      const sent = sentByCard.get(serverCard.id);
      const pendingWasNotInThisRequest = pending && !sent;
      const newerEditWasSaved =
        pending &&
        sent &&
        pending.mutationId !== sent.mutationId &&
        acknowledged.has(sent.mutationId);

      if (pendingWasNotInThisRequest || newerEditWasSaved) {
        const rebased = { ...pending, baseServerRevision: serverCard.revision };
        mutationStore.put(encodeStoredMutation(rebased));
        pendingByCard.set(serverCard.id, rebased);
      }

      if (local && pendingByCard.has(serverCard.id)) {
        merged.set(serverCard.id, {
          ...local,
          displayId: { kind: 'official', value: serverCard.officialDisplayId },
          serverRevision: serverCard.revision,
        });
        continue;
      }

      merged.set(serverCard.id, {
        id: serverCard.id,
        displayId: { kind: 'official', value: serverCard.officialDisplayId },
        title: serverCard.title,
        body: serverCard.body,
        createdAt: serverCard.createdAt,
        updatedAt: serverCard.updatedAt,
        localRevision: local?.localRevision ?? serverCard.revision,
        serverRevision: serverCard.revision,
      });
    }

    const reconciled = reconcileProvisionalDisplayIds([...merged.values()]);
    for (const card of reconciled) cardStore.put(encodeStoredCard(card));

    conflictStore.clear();
    for (const conflict of response.conflicts) {
      conflictStore.put(encodeStoredConflict(conflict));
    }
    await completion;

    return { cards: reconciled, conflicts: response.conflicts };
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have aborted or committed.
    }
    try {
      await completion;
    } catch {
      // The original decode/apply error is the useful diagnostic.
    }
    throw error;
  }
}

export async function clearNotesDatabaseForTests(): Promise<void> {
  if (databasePromise) {
    const database = await databasePromise;
    database.close();
  }
  databasePromise = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE_NAME);
    request.addEventListener('success', () => resolve(), { once: true });
    request.addEventListener('blocked', () => resolve(), { once: true });
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    });
  });
}
