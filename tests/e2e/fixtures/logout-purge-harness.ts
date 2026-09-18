import { vaultNotesDatabaseName } from '@/lib/application/notes-database-scope';
import type { LogoutRuntimeFenceLease } from '@/lib/application/logout-runtime-coordination';
import type { LogoutPurgeGeneration } from '@/lib/application/logout-purge';
import { createBrowserAccountDeletionRunner } from '@/lib/client/browser-account-deletion';
import { createBrowserAccountDeletionProgressPort } from '@/lib/client/browser-account-deletion-progress';
import { createBrowserLogoutPurgeService } from '@/lib/client/browser-logout-purge';
import { createBrowserLogoutPurgeProgressPort } from '@/lib/client/browser-logout-purge-progress';
import {
  connectionsLayoutWorkerIsReset,
  prepareConnectionsLayoutWorker,
} from '@/lib/client/connections-layout-worker';
import {
  parseAccountId,
  parseSessionId,
  parseVaultId,
  sessionEpochDecoder,
} from '@/lib/domain/identity';
import { decodeOrThrow } from '@/lib/codec/core';

type VaultSnapshot = {
  readonly present: boolean;
  readonly titles: readonly string[];
};

type LogoutPurgeHarness = {
  seedVault: (
    generation: unknown,
    cardId: unknown,
    title: unknown,
  ) => Promise<void>;
  snapshotVault: (generation: unknown) => Promise<VaultSnapshot>;
  seedNotesCache: () => Promise<void>;
  cacheNames: () => Promise<readonly string[]>;
  prepareGraphWorker: () => Promise<void>;
  graphWorkerIsReset: () => boolean;
  enterFence: (generation: unknown) => Promise<unknown>;
  fenceStatus: () => string;
  closeFence: () => Promise<void>;
  runPurge: (generation: unknown) => Promise<unknown>;
  progressMarker: () => Promise<unknown>;
  beginAccountDeletion: (generation: unknown) => Promise<unknown>;
  recoverAccountDeletion: () => Promise<unknown>;
  resumeAccountDeletion: () => Promise<unknown>;
  accountDeletionMarker: () => Promise<unknown>;
  accountDeletionRemoteCalls: () => readonly string[];
};

declare global {
  interface Window {
    __fukamuLogoutPurgeHarness: LogoutPurgeHarness;
  }
}

const service = createBrowserLogoutPurgeService({
  lockTimeoutMs: 5_000,
  serviceWorkerTimeoutMs: 5_000,
});
const accountDeletionRemoteCalls: string[] = [];
const accountDeletion = createBrowserAccountDeletionRunner(service, {
  fetchRequest: accountDeletionFetch,
  randomValues: (bytes) => bytes.fill(0),
  clock: { now: () => 2_000 },
});
let fenceLease: LogoutRuntimeFenceLease | undefined;
let fenceState = 'idle';

window.__fukamuLogoutPurgeHarness = {
  async seedVault(input, cardId, title) {
    if (typeof cardId !== 'string' || typeof title !== 'string') {
      throw new Error('invalid card fixture');
    }
    const generation = decodeGeneration(input);
    const database = await openVaultDatabase(generation);
    try {
      const transaction = database.transaction('cards', 'readwrite');
      transaction.objectStore('cards').put({ id: cardId, title });
      await transactionCompletion(transaction);
    } finally {
      database.close();
    }
  },
  async snapshotVault(input) {
    const generation = decodeGeneration(input);
    const name = vaultNotesDatabaseName({
      accountId: generation.accountId,
      vaultId: generation.vaultId,
    });
    const databases: unknown = await indexedDB.databases();
    if (!databaseNames(databases).includes(name)) {
      return { present: false, titles: [] };
    }
    const database = await openVaultDatabase(generation);
    try {
      const transaction = database.transaction('cards', 'readonly');
      const cards = await requestValue(
        transaction.objectStore('cards').getAll(),
      );
      await transactionCompletion(transaction);
      return { present: true, titles: cardTitles(cards) };
    } finally {
      database.close();
    }
  },
  async seedNotesCache() {
    const cache = await caches.open('fukamu-notes-e2e-private');
    await cache.put('/__e2e-private', new Response('private fixture'));
  },
  cacheNames: () => caches.keys(),
  prepareGraphWorker: prepareConnectionsLayoutWorker,
  graphWorkerIsReset: connectionsLayoutWorkerIsReset,
  async enterFence(input) {
    const generation = decodeGeneration(input);
    let purgeRequested = false;
    fenceState = 'entering';
    const result = await service.runtimeFence.enter({
      generation,
      onPurgeRequested: () => {
        purgeRequested = true;
        fenceState = 'quiescing';
        if (fenceLease) void quiesceFence(fenceLease);
      },
    });
    if (result.kind === 'blocked') {
      fenceState = `blocked:${result.reason}`;
      return result;
    }
    fenceLease = result.lease;
    fenceState = 'entered';
    if (purgeRequested) await quiesceFence(result.lease);
    return { kind: 'entered' };
  },
  fenceStatus: () => fenceState,
  async closeFence() {
    const lease = fenceLease;
    fenceLease = undefined;
    if (lease) await lease.close();
    fenceState = 'closed';
  },
  runPurge: (input) => service.purge.run(decodeGeneration(input)),
  progressMarker: () => createBrowserLogoutPurgeProgressPort().read(),
  beginAccountDeletion: (input) =>
    accountDeletion.begin(decodeGeneration(input)),
  recoverAccountDeletion: () => accountDeletion.recover(),
  resumeAccountDeletion: () => accountDeletion.resumeServer(),
  accountDeletionMarker: () =>
    createBrowserAccountDeletionProgressPort().read(),
  accountDeletionRemoteCalls: () => [...accountDeletionRemoteCalls],
};

async function accountDeletionFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const endpoint =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.pathname
        : new URL(input.url).pathname;
  if (init?.method !== 'POST' || typeof init.body !== 'string') {
    return Response.json({ error: 'invalid-fixture-request' }, { status: 400 });
  }
  const body: unknown = JSON.parse(init.body);
  if (!isRecord(body)) {
    return Response.json({ error: 'invalid-fixture-request' }, { status: 400 });
  }
  if (endpoint === '/api/account/deletion') {
    if (body.idempotencyKey !== 'A'.repeat(43)) {
      return Response.json({ error: 'invalid-fixture-key' }, { status: 400 });
    }
    accountDeletionRemoteCalls.push('start');
    return Response.json(
      {
        status: 'in-progress',
        continuationToken: `ad1.${'S'.repeat(43)}.0`,
      },
      { status: 202 },
    );
  }
  if (endpoint !== '/api/account/deletion/status') {
    return Response.json({ error: 'unknown-fixture-route' }, { status: 404 });
  }
  if (body.continuationToken === `ad1.${'S'.repeat(43)}.0`) {
    accountDeletionRemoteCalls.push('resume:0');
    return Response.json(
      {
        status: 'in-progress',
        continuationToken: `ad1.${'S'.repeat(43)}.1`,
      },
      { status: 202 },
    );
  }
  if (body.continuationToken === `ad1.${'S'.repeat(43)}.1`) {
    accountDeletionRemoteCalls.push('resume:1');
    return Response.json({ status: 'completed' });
  }
  return Response.json({ error: 'invalid-fixture-token' }, { status: 401 });
}

async function quiesceFence(lease: LogoutRuntimeFenceLease): Promise<void> {
  await lease.quiesce();
  fenceState = 'quiesced';
}

function decodeGeneration(input: unknown): LogoutPurgeGeneration {
  if (!isRecord(input)) throw new Error('invalid logout generation');
  return {
    accountId: parseAccountId(input.accountId),
    vaultId: parseVaultId(input.vaultId),
    sessionId: parseSessionId(input.sessionId),
    sessionEpoch: decodeOrThrow(
      sessionEpochDecoder,
      input.sessionEpoch,
      'SessionEpoch',
    ),
  };
}

function openVaultDatabase(
  generation: LogoutPurgeGeneration,
): Promise<IDBDatabase> {
  const name = vaultNotesDatabaseName({
    accountId: generation.accountId,
    vaultId: generation.vaultId,
  });
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, 1);
    request.addEventListener('upgradeneeded', () => {
      for (const store of ['cards', 'mutations', 'conflicts']) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store, { keyPath: 'id' });
        }
      }
      if (!request.result.objectStoreNames.contains('meta')) {
        request.result.createObjectStore('meta', { keyPath: 'key' });
      }
    });
    request.addEventListener('success', () => resolve(request.result), {
      once: true,
    });
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    });
  });
}

function requestValue(request: IDBRequest): Promise<unknown> {
  return new Promise((resolve, reject) => {
    request.addEventListener('success', () => {
      const value: unknown = request.result;
      resolve(value);
    });
    request.addEventListener('error', () => reject(request.error), {
      once: true,
    });
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener('complete', () => resolve(), { once: true });
    transaction.addEventListener('error', () => reject(transaction.error), {
      once: true,
    });
    transaction.addEventListener('abort', () => reject(transaction.error), {
      once: true,
    });
  });
}

function databaseNames(input: unknown): readonly string[] {
  if (!Array.isArray(input)) throw new Error('invalid database listing');
  const names: string[] = [];
  for (const value of input) {
    if (!isRecord(value)) throw new Error('invalid database info');
    if (value.name === undefined) continue;
    if (typeof value.name !== 'string')
      throw new Error('invalid database name');
    names.push(value.name);
  }
  return names;
}

function cardTitles(input: unknown): readonly string[] {
  if (!Array.isArray(input)) throw new Error('invalid card listing');
  const titles: string[] = [];
  for (const value of input) {
    if (!isRecord(value) || typeof value.title !== 'string') {
      throw new Error('invalid card fixture row');
    }
    titles.push(value.title);
  }
  return titles;
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}
