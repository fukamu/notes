import { createInternalId } from '@/lib/domain/id';
import { reconcileProvisionalDisplayIds } from '@/lib/domain/display-id';
import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '@/lib/domain/types';
import type { SyncResponse } from '@/lib/sync/protocol';

const DATABASE_NAME = 'fukamu-notes';
const DATABASE_VERSION = 1;

type MetaRecord = { key: string; value: string };

let databasePromise: Promise<IDBDatabase> | undefined;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
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
  return requestResult(transaction.objectStore('cards').getAll());
}

export async function loadPendingMutations(): Promise<PendingMutation[]> {
  const database = await openNotesDatabase();
  const transaction = database.transaction('mutations', 'readonly');
  return requestResult(transaction.objectStore('mutations').getAll());
}

export async function loadConflicts(): Promise<ConflictRecord[]> {
  const database = await openNotesDatabase();
  const transaction = database.transaction('conflicts', 'readonly');
  return requestResult(transaction.objectStore('conflicts').getAll());
}

export async function loadOrCreateDeviceId(): Promise<string> {
  const database = await openNotesDatabase();
  const transaction = database.transaction('meta', 'readwrite');
  const store = transaction.objectStore('meta');
  const existing = (await requestResult(store.get('deviceId'))) as
    | MetaRecord
    | undefined;
  if (existing) return existing.value;
  const value = createInternalId();
  store.put({ key: 'deviceId', value } satisfies MetaRecord);
  await transactionComplete(transaction);
  return value;
}

export async function persistCardAndMutation(
  card: CardRecord,
  kind: PendingMutation['kind'] = 'upsert',
  conflictIds: string[] = [],
): Promise<PendingMutation> {
  const database = await openNotesDatabase();
  const mutation: PendingMutation = {
    mutationId: createInternalId(),
    cardId: card.id,
    kind,
    baseServerRevision: card.serverRevision,
    title: card.title,
    body: card.body,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
    conflictIds,
  };
  const transaction = database.transaction(['cards', 'mutations'], 'readwrite');
  transaction.objectStore('cards').put(card);
  transaction.objectStore('mutations').put(mutation);
  await transactionComplete(transaction);
  return mutation;
}

export async function applySyncResponse(
  response: SyncResponse,
  sentMutations: PendingMutation[],
): Promise<{ cards: CardRecord[]; conflicts: ConflictRecord[] }> {
  const database = await openNotesDatabase();
  const transaction = database.transaction(
    ['cards', 'mutations', 'conflicts'],
    'readwrite',
  );
  const cardStore = transaction.objectStore('cards');
  const mutationStore = transaction.objectStore('mutations');
  const conflictStore = transaction.objectStore('conflicts');
  const localCards = (await requestResult(cardStore.getAll())) as CardRecord[];
  const currentMutations = (await requestResult(
    mutationStore.getAll(),
  )) as PendingMutation[];
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
      mutationStore.put(rebased);
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
  for (const card of reconciled) cardStore.put(card);

  conflictStore.clear();
  for (const conflict of response.conflicts) conflictStore.put(conflict);
  await transactionComplete(transaction);

  return { cards: reconciled, conflicts: response.conflicts };
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
