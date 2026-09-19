import type {
  IdGenerator,
  NotesRepository,
  NotesSyncRequestSnapshot,
} from '@/lib/application/notes-runtime';
import type { VaultNotesScope } from '@/lib/application/notes-access';
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
import type { SyncV2CommitPlan } from '@/lib/sync/v2-page-application';
import {
  initialSyncV2Checkpoint,
  planSyncV2ReplicaCommit,
  type SyncV2ReplicaCommitResult,
  type SyncV2ReplicaRepository,
} from '@/lib/sync/v2-replica';
import { assertNever } from '@/lib/shared/invariant';
import {
  decodeStoredCards,
  decodeStoredConflicts,
  decodeStoredMeta,
  decodeStoredMutations,
  decodeStoredSyncV2Checkpoint,
  encodeStoredCard,
  encodeStoredConflict,
  encodeStoredMeta,
  encodeStoredMutation,
  encodeStoredSyncV2Checkpoint,
} from '@/lib/storage/records';

const DATABASE_VERSION = 2;
const SYNC_V2_STORE_NAME = 'sync-v2';

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
      if (!database.objectStoreNames.contains(SYNC_V2_STORE_NAME)) {
        database.createObjectStore(SYNC_V2_STORE_NAME, { keyPath: 'key' });
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

async function loadSyncRequestSnapshot(
  scope: IndexedDbNotesScope,
): Promise<NotesSyncRequestSnapshot> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction(['cards', 'mutations'], 'readonly');
  const cardsRequest = transaction.objectStore('cards').getAll();
  const mutationsRequest = transaction.objectStore('mutations').getAll();
  const [cardsInput, mutationsInput] = await Promise.all([
    requestResult(cardsRequest),
    requestResult(mutationsRequest),
  ]);
  const cards = decodeStoredCards(cardsInput);
  return {
    sentMutations: decodeStoredMutations(mutationsInput),
    revisionsAtRequest: new Map(
      cards.map((card) => [card.id, card.localRevision]),
    ),
  };
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

function checkpointFromStored(input: unknown) {
  if (input === undefined) return initialSyncV2Checkpoint();
  const stored = decodeStoredSyncV2Checkpoint(input);
  return {
    cursor: stored.cursor,
    highWatermark: stored.highWatermark,
  };
}

async function loadSyncV2Checkpoint(
  scope: VaultNotesScope,
): Promise<ReturnType<typeof initialSyncV2Checkpoint>> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction(SYNC_V2_STORE_NAME, 'readonly');
  const stored = await requestResult(
    transaction.objectStore(SYNC_V2_STORE_NAME).get('checkpoint'),
  );
  return checkpointFromStored(stored);
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
  const transaction = database.transaction(['cards', 'mutations'], 'readwrite');
  const cardStore = transaction.objectStore('cards');
  const mutationStore = transaction.objectStore('mutations');
  const completion = transactionComplete(transaction);
  try {
    const storedMutationInput = await requestResult(mutationStore.get(card.id));
    const [existingMutation] = decodeStoredMutations(
      storedMutationInput === undefined ? [] : [storedMutationInput],
    );
    const result = createPendingMutation(
      card,
      idGenerator.createMutationId(),
      options,
      existingMutation,
    );
    if (!result.ok) {
      throw new Error(`Cannot persist pending mutation: ${result.reason}`);
    }
    const mutation = result.mutation;
    cardStore.put(encodeStoredCard(card));
    mutationStore.put(encodeStoredMutation(mutation));
    await completion;
    return mutation;
  } catch (error) {
    try {
      transaction.abort();
    } catch {
      // The transaction may already have aborted or committed.
    }
    try {
      await completion;
    } catch {
      // Preserve the original decode or planning failure.
    }
    throw error;
  }
}

async function persistLocalCard(
  scope: IndexedDbNotesScope,
  card: CardRecord,
): Promise<void> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction('cards', 'readwrite');
  transaction.objectStore('cards').put(encodeStoredCard(card));
  await transactionComplete(transaction);
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

async function applySyncV2Commit(
  scope: VaultNotesScope,
  plan: SyncV2CommitPlan,
  sentMutations: readonly PendingMutation[],
): Promise<SyncV2ReplicaCommitResult> {
  const database = await openNotesDatabase(scope);
  const transaction = database.transaction(
    ['cards', 'mutations', 'conflicts', SYNC_V2_STORE_NAME],
    'readwrite',
  );
  const cardStore = transaction.objectStore('cards');
  const mutationStore = transaction.objectStore('mutations');
  const conflictStore = transaction.objectStore('conflicts');
  const checkpointStore = transaction.objectStore(SYNC_V2_STORE_NAME);
  const completion = transactionComplete(transaction);

  try {
    const [cardsInput, mutationsInput, conflictsInput, checkpointInput] =
      await Promise.all([
        requestResult(cardStore.getAll()),
        requestResult(mutationStore.getAll()),
        requestResult(conflictStore.getAll()),
        requestResult(checkpointStore.get('checkpoint')),
      ]);
    const decision = planSyncV2ReplicaCommit({
      plan,
      currentCheckpoint: checkpointFromStored(checkpointInput),
      localCards: decodeStoredCards(cardsInput),
      currentMutations: decodeStoredMutations(mutationsInput),
      localConflicts: decodeStoredConflicts(conflictsInput),
      sentMutations,
    });

    switch (decision.kind) {
      case 'already-applied':
      case 'rejected':
        await completion;
        return decision;
      case 'apply':
        for (const operation of decision.operations) {
          switch (operation.type) {
            case 'delete-card':
              cardStore.delete(operation.cardId);
              break;
            case 'put-card':
              cardStore.put(encodeStoredCard(operation.card));
              break;
            case 'delete-mutation':
              mutationStore.delete(operation.cardId);
              break;
            case 'put-mutation':
              mutationStore.put(encodeStoredMutation(operation.mutation));
              break;
            case 'delete-conflict':
              conflictStore.delete(operation.conflictId);
              break;
            case 'put-conflict':
              conflictStore.put(encodeStoredConflict(operation.conflict));
              break;
            default:
              assertNever(operation, 'Unsupported Sync v2 storage operation');
          }
        }
        checkpointStore.put(encodeStoredSyncV2Checkpoint(decision.checkpoint));
        await completion;
        return {
          kind: 'applied',
          checkpoint: decision.checkpoint,
          cards: decision.cards,
          conflicts: decision.conflicts,
        };
      default:
        return assertNever(decision, 'Unsupported Sync v2 commit decision');
    }
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
    loadSyncRequestSnapshot: () => loadSyncRequestSnapshot(scope),
    persistLocalCard: (card) => persistLocalCard(scope, card),
    persistCardAndMutation: (card, options) =>
      persistCardAndMutation(scope, idGenerator, card, options),
    applySyncResponse: (input, sentMutations) =>
      applySyncResponse(scope, input, sentMutations),
  };
}

export function createIndexedDbSyncV2ReplicaRepository<
  TScope extends VaultNotesScope,
>(scope: TScope): SyncV2ReplicaRepository<TScope> {
  return {
    scope,
    loadCheckpoint: () => loadSyncV2Checkpoint(scope),
    applyCommit: (plan, sentMutations) =>
      applySyncV2Commit(scope, plan, sentMutations),
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
