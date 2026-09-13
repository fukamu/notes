import type {
  IdGenerator,
  NotesRepository,
} from '@/lib/application/notes-runtime';
import {
  notesDatabaseName,
  type CloseNotesDatabaseResult,
  type DeleteNotesDatabaseResult,
  type IndexedDbNotesScope,
  type NotesDatabaseName,
  type VerifyNotesDatabaseDeletionResult,
} from '@/lib/application/notes-database-scope';
import {
  createPendingMutation,
  type PendingMutationMode,
} from '@/lib/domain/card-transitions';
import type { DeviceId } from '@/lib/domain/id';
import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '@/lib/domain/types';
import { decodeSyncResponse } from '@/lib/sync/protocol';
import { planSyncResponseApplication } from '@/lib/sync/client-reconciliation';
import { assertNever } from '@/lib/shared/invariant';
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

const DATABASE_VERSION = 1;

const databasePromises = new Map<NotesDatabaseName, Promise<IDBDatabase>>();

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

export function openNotesDatabase(
  scope: IndexedDbNotesScope,
): Promise<IDBDatabase> {
  const databaseName = notesDatabaseName(scope);
  const existing = databasePromises.get(databaseName);
  if (existing) return existing;

  let request: IDBOpenDBRequest;
  try {
    request = indexedDB.open(databaseName, DATABASE_VERSION);
  } catch (error) {
    return Promise.reject(error);
  }

  const opening = new Promise<IDBDatabase>((resolve, reject) => {
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
    request.addEventListener('success', () => {
      const database = request.result;
      database.addEventListener(
        'versionchange',
        () => {
          database.close();
          if (databasePromises.get(databaseName) === opening) {
            databasePromises.delete(databaseName);
          }
        },
        { once: true },
      );
      resolve(database);
    });
    request.addEventListener('error', () => {
      if (databasePromises.get(databaseName) === opening) {
        databasePromises.delete(databaseName);
      }
      reject(request.error);
    });
  });
  databasePromises.set(databaseName, opening);
  return opening;
}

export async function closeNotesDatabase(
  scope: IndexedDbNotesScope,
): Promise<CloseNotesDatabaseResult> {
  const databaseName = notesDatabaseName(scope);
  const opening = databasePromises.get(databaseName);
  if (!opening) return { kind: 'not-open' };

  try {
    const database = await opening;
    if (databasePromises.get(databaseName) === opening) {
      databasePromises.delete(databaseName);
    }
    database.close();
    return { kind: 'closed' };
  } catch {
    if (databasePromises.get(databaseName) === opening) {
      databasePromises.delete(databaseName);
    }
    return { kind: 'not-open' };
  }
}

export async function deleteNotesDatabase(
  scope: IndexedDbNotesScope,
): Promise<DeleteNotesDatabaseResult> {
  await closeNotesDatabase(scope);
  let request: IDBOpenDBRequest;
  try {
    request = indexedDB.deleteDatabase(notesDatabaseName(scope));
  } catch {
    return { kind: 'failed', reason: 'request-threw' };
  }

  return new Promise((resolve) => {
    request.addEventListener('success', () => resolve({ kind: 'deleted' }), {
      once: true,
    });
    request.addEventListener('blocked', () => resolve({ kind: 'blocked' }), {
      once: true,
    });
    request.addEventListener(
      'error',
      () => resolve({ kind: 'failed', reason: 'request-error' }),
      {
        once: true,
      },
    );
  });
}

export function notesDatabaseConnectionIsClosed(
  scope: IndexedDbNotesScope,
): boolean {
  return !databasePromises.has(notesDatabaseName(scope));
}

/** Verifies absence without opening (and therefore recreating) the database. */
export async function verifyNotesDatabaseDeleted(
  scope: IndexedDbNotesScope,
  factory: IDBFactory = indexedDB,
): Promise<VerifyNotesDatabaseDeletionResult> {
  const databasesValue: unknown = Reflect.get(factory, 'databases');
  if (typeof databasesValue !== 'function') {
    return { kind: 'unsupported-capability' };
  }
  try {
    const input: unknown = await Reflect.apply(databasesValue, factory, []);
    if (!Array.isArray(input)) return { kind: 'failed' };
    const expectedName = notesDatabaseName(scope);
    for (const value of input) {
      if (!isDatabaseInfo(value)) return { kind: 'failed' };
      if (value.name === expectedName) return { kind: 'still-present' };
    }
    return { kind: 'verified-deleted' };
  } catch {
    return { kind: 'failed' };
  }
}

async function loadCards(scope: IndexedDbNotesScope): Promise<CardRecord[]> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction('cards', 'readonly');
  return decodeStoredCards(
    await requestResult(transaction.objectStore('cards').getAll()),
  );
}

async function loadPendingMutations(
  scope: IndexedDbNotesScope,
): Promise<PendingMutation[]> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction('mutations', 'readonly');
  return decodeStoredMutations(
    await requestResult(transaction.objectStore('mutations').getAll()),
  );
}

async function loadConflicts(
  scope: IndexedDbNotesScope,
): Promise<ConflictRecord[]> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction('conflicts', 'readonly');
  return decodeStoredConflicts(
    await requestResult(transaction.objectStore('conflicts').getAll()),
  );
}

async function loadOrCreateDeviceId(
  scope: IndexedDbNotesScope,
  idGenerator: IdGenerator,
): Promise<DeviceId> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction('meta', 'readwrite');
  const store = transaction.objectStore('meta');
  const existing = await requestResult(store.get('deviceId'));
  if (existing !== undefined) return decodeStoredMeta(existing).value;
  const value = idGenerator.createDeviceId();
  store.put(encodeStoredMeta(value));
  await transactionComplete(transaction);
  return value;
}

async function persistCardAndMutation(
  scope: IndexedDbNotesScope,
  idGenerator: IdGenerator,
  card: CardRecord,
  options: PendingMutationMode = {
    kind: 'upsert',
  },
): Promise<PendingMutation> {
  const database = await openNotesDatabase(scope);
  const result = createPendingMutation(
    card,
    idGenerator.createMutationId(),
    options,
  );
  if (!result.ok) {
    throw new Error('Cannot resolve a conflict without a server revision');
  }
  const mutation = result.mutation;
  const transaction = database.transaction(['cards', 'mutations'], 'readwrite');
  transaction.objectStore('cards').put(encodeStoredCard(card));
  transaction.objectStore('mutations').put(encodeStoredMutation(mutation));
  await transactionComplete(transaction);
  return mutation;
}

async function applySyncResponse(
  scope: IndexedDbNotesScope,
  input: unknown,
  sentMutations: PendingMutation[],
): Promise<{ cards: CardRecord[]; conflicts: ConflictRecord[] }> {
  // Decode the complete response and its cross-field invariants before opening
  // a readwrite transaction. Invalid 2xx payloads cannot delete mutations.
  const response = decodeSyncResponse(input, sentMutations);
  const database = await openNotesDatabase(scope);
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
    const plan = planSyncResponseApplication({
      response,
      localCards,
      currentMutations,
      sentMutations,
    });

    for (const operation of plan.operations) {
      switch (operation.type) {
        case 'delete-mutation':
          mutationStore.delete(operation.cardId);
          break;
        case 'put-mutation':
          mutationStore.put(encodeStoredMutation(operation.mutation));
          break;
        case 'put-card':
          cardStore.put(encodeStoredCard(operation.card));
          break;
        case 'clear-conflicts':
          conflictStore.clear();
          break;
        case 'put-conflict':
          conflictStore.put(encodeStoredConflict(operation.conflict));
          break;
        default:
          assertNever(operation, 'Unsupported sync storage operation');
      }
    }
    await completion;

    return { cards: plan.cards, conflicts: plan.conflicts };
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

export function createIndexedDbNotesRepository<
  TScope extends IndexedDbNotesScope,
>(scope: TScope, idGenerator: IdGenerator): NotesRepository<TScope> {
  return {
    scope,
    loadCards: () => loadCards(scope),
    loadConflicts: () => loadConflicts(scope),
    loadOrCreateDeviceId: () => loadOrCreateDeviceId(scope, idGenerator),
    loadPendingMutations: () => loadPendingMutations(scope),
    persistCardAndMutation: (card, options) =>
      persistCardAndMutation(scope, idGenerator, card, options),
    applySyncResponse: (input, sentMutations) =>
      applySyncResponse(scope, input, sentMutations),
  };
}

export async function clearNotesDatabaseForTests(
  scope: IndexedDbNotesScope,
): Promise<void> {
  const result = await deleteNotesDatabase(scope);
  switch (result.kind) {
    case 'deleted':
      return;
    case 'blocked':
      throw new Error('Test database deletion was blocked');
    case 'failed':
      throw new Error(`Test database deletion failed: ${result.reason}`);
    default:
      return assertNever(result, 'Unsupported database deletion result');
  }
}

function isDatabaseInfo(value: unknown): value is { readonly name?: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  if (!('name' in value)) return true;
  return value.name === undefined || typeof value.name === 'string';
}
