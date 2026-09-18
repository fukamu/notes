/** @vitest-environment happy-dom */

import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import type {
  ForegroundResumePort,
  NotesRepository,
  NotesRuntimePorts,
  SyncTransport,
} from '@/lib/application/notes-runtime';
import {
  createSyncV2Client,
  type SyncV2Client,
  type SyncV2ClientResult,
} from '@/lib/application/sync-v2-client';
import {
  NotesProvider,
  useNotesDataStore,
  type NotesDataStore,
} from '@/lib/client/notes-store';
import { createPendingMutation } from '@/lib/domain/card-transitions';
import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '@/lib/domain/types';
import { initialSyncV2Checkpoint } from '@/lib/sync/v2-replica';
import {
  parseSyncSequence,
  parseSyncV2Cursor,
  SYNC_V2_VERSION,
} from '@/lib/sync/v2-protocol';
import { compatibilityIds } from '@/tests/fixtures/compatibility';
import {
  fixtureCardId,
  fixtureConflictId,
  fixtureMutationId,
} from '@/tests/fixtures/ids';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const vaultScope: VaultNotesScope = {
  kind: 'vault',
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

type RuntimeHarness = {
  readonly ports: NotesRuntimePorts<VaultNotesScope>;
  readonly repository: NotesRepository<VaultNotesScope>;
  readonly transport: SyncTransport<VaultNotesScope>;
  readonly resumeForeground: () => void;
  readonly resumeLastForegroundSubscriber: () => void;
};

type RuntimeOverrides = {
  readonly scope?: VaultNotesScope;
  readonly online?: boolean;
  readonly loadCards?: () => Promise<CardRecord[]>;
  readonly loadConflicts?: () => Promise<ConflictRecord[]>;
  readonly loadPendingMutations?: () => Promise<PendingMutation[]>;
  readonly persistLocalCard?: (card: CardRecord) => Promise<void>;
  readonly persistCardAndMutation?: (
    card: CardRecord,
  ) => Promise<PendingMutation>;
  readonly applySyncResponse?: () => Promise<{
    cards: CardRecord[];
    conflicts: [];
  }>;
  readonly send?: () => Promise<unknown>;
};

let root: Root | undefined;
let observedStore: NotesDataStore | undefined;

beforeAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = undefined;
  }
  observedStore = undefined;
  document.body.replaceChildren();
});

function card(label: string, title: string): CardRecord {
  return {
    id: fixtureCardId(label),
    displayId: { kind: 'official', value: 1 },
    title,
    body: [],
    createdAt: 1_000,
    updatedAt: 1_000,
    localRevision: 1,
    serverRevision: 1,
  };
}

function mutationFor(cardRecord: CardRecord): PendingMutation {
  const result = createPendingMutation(
    cardRecord,
    fixtureMutationId(`provider-${cardRecord.id}`),
    { kind: 'upsert' },
  );
  if (!result.ok) throw new Error('upsert fixture was rejected');
  return result.mutation;
}

function createRuntimeHarness(
  overrides: RuntimeOverrides = {},
): RuntimeHarness {
  const scope = overrides.scope ?? vaultScope;
  let cardSequence = 0;
  const repository: NotesRepository<VaultNotesScope> = {
    scope,
    loadCards: vi.fn(overrides.loadCards ?? (async () => [])),
    loadConflicts: vi.fn(overrides.loadConflicts ?? (async () => [])),
    loadOrCreateDeviceId: vi.fn(async () => compatibilityIds.device),
    loadPendingMutations: vi.fn(
      overrides.loadPendingMutations ?? (async () => []),
    ),
    persistLocalCard: vi.fn(overrides.persistLocalCard ?? (async () => {})),
    persistCardAndMutation: vi.fn(
      overrides.persistCardAndMutation ??
        (async (cardRecord) => mutationFor(cardRecord)),
    ),
    applySyncResponse: vi.fn(
      overrides.applySyncResponse ??
        (async () => ({ cards: [], conflicts: [] })),
    ),
  };
  const transport: SyncTransport<VaultNotesScope> = {
    scope,
    send: vi.fn(overrides.send ?? (async () => ({}))),
  };
  const foregroundSubscribers = new Set<() => void>();
  let lastForegroundSubscriber: (() => void) | undefined;
  const foregroundResume: ForegroundResumePort = {
    subscribe: vi.fn<ForegroundResumePort['subscribe']>((onResume) => {
      lastForegroundSubscriber = onResume;
      foregroundSubscribers.add(onResume);
      return () => foregroundSubscribers.delete(onResume);
    }),
  };
  return {
    repository,
    transport,
    resumeForeground: () => {
      for (const subscriber of foregroundSubscribers) subscriber();
    },
    resumeLastForegroundSubscriber: () => lastForegroundSubscriber?.(),
    ports: {
      scope,
      repository,
      sync: { kind: 'v1', transport },
      clock: { now: () => 2_000 + cardSequence },
      idGenerator: {
        createCardId: () => fixtureCardId(`provider-card-${++cardSequence}`),
        createMutationId: () =>
          fixtureMutationId(`provider-mutation-${cardSequence}`),
        createDeviceId: () => compatibilityIds.device,
      },
      connectivity: {
        isOnline: () => overrides.online ?? false,
        subscribe: vi.fn(() => () => undefined),
      },
      foregroundResume,
      offlineApp: {
        prepare: vi.fn(async () => undefined),
        purge: vi.fn(async () => undefined),
      },
    },
  };
}

function createV2RuntimeHarness(
  client: SyncV2Client<VaultNotesScope>,
  overrides: RuntimeOverrides = {},
): RuntimeHarness {
  const harness = createRuntimeHarness(overrides);
  return {
    ...harness,
    ports: {
      ...harness.ports,
      sync: { kind: 'v2', client },
    },
  };
}

function StoreProbe() {
  const store = useNotesDataStore();
  useEffect(() => {
    observedStore = store;
  }, [store]);
  return null;
}

function currentStore(): NotesDataStore {
  if (!observedStore) throw new Error('Notes store has not mounted');
  return observedStore;
}

async function renderRuntime(
  harness: RuntimeHarness,
  runtimeKey: string,
  fenced = false,
): Promise<void> {
  if (!root) {
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    const providerProperties = {
      key: runtimeKey,
      ports: harness.ports,
      fenced,
      fencedFallback: createElement('p', null, 'Runtime fenced'),
      children: createElement(StoreProbe),
    };
    root?.render(createElement(NotesProvider, providerProperties));
    // Keep the Provider's zero-delay initial-sync callback inside React act.
    await new Promise((resolve) => window.setTimeout(resolve, 25));
  });
}

async function flushAsyncCompletion(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await Promise.resolve();
}

describe('NotesProvider operation lifecycle', () => {
  it('synchronizes once when an idle online runtime resumes', async () => {
    const runtime = createRuntimeHarness({ online: true });

    await renderRuntime(runtime, 'foreground-idle-runtime');
    await vi.waitFor(() =>
      expect(runtime.transport.send).toHaveBeenCalledOnce(),
    );
    vi.mocked(runtime.transport.send).mockClear();

    act(() => runtime.resumeForeground());

    await vi.waitFor(() =>
      expect(runtime.transport.send).toHaveBeenCalledOnce(),
    );
  });

  it('coalesces a resume during sync into the existing follow-up request', async () => {
    const firstResponse = Promise.withResolvers<unknown>();
    let sendCount = 0;
    const runtime = createRuntimeHarness({
      online: true,
      send: async () => {
        sendCount += 1;
        return sendCount === 1 ? firstResponse.promise : {};
      },
    });

    await renderRuntime(runtime, 'foreground-single-flight-runtime');
    await vi.waitFor(() =>
      expect(runtime.transport.send).toHaveBeenCalledOnce(),
    );

    act(() => runtime.resumeForeground());
    expect(runtime.transport.send).toHaveBeenCalledOnce();

    await act(async () => {
      firstResponse.resolve({});
      await vi.waitFor(() =>
        expect(runtime.transport.send).toHaveBeenCalledTimes(2),
      );
    });
  });

  it('does not send while offline when the runtime resumes', async () => {
    const runtime = createRuntimeHarness({ online: false });

    await renderRuntime(runtime, 'foreground-offline-runtime');
    act(() => runtime.resumeForeground());
    await flushAsyncCompletion();

    expect(runtime.transport.send).not.toHaveBeenCalled();
    expect(currentStore().syncState).toBe('offline');
  });

  it('rejects foreground callbacks after a fence, runtime switch, or unmount', async () => {
    const fencedRuntime = createRuntimeHarness({ online: true });
    await renderRuntime(fencedRuntime, 'foreground-fence-runtime');
    await vi.waitFor(() =>
      expect(fencedRuntime.transport.send).toHaveBeenCalledOnce(),
    );
    vi.mocked(fencedRuntime.transport.send).mockClear();

    await renderRuntime(fencedRuntime, 'foreground-fence-runtime', true);
    act(() => fencedRuntime.resumeLastForegroundSubscriber());
    await flushAsyncCompletion();
    expect(fencedRuntime.transport.send).not.toHaveBeenCalled();

    const oldRuntime = createRuntimeHarness({ online: true });
    const nextRuntime = createRuntimeHarness({
      scope: { ...vaultScope, vaultId: sessionFixtureIds.otherVaultId },
      online: false,
    });
    await renderRuntime(oldRuntime, 'foreground-old-runtime');
    await vi.waitFor(() =>
      expect(oldRuntime.transport.send).toHaveBeenCalledOnce(),
    );
    vi.mocked(oldRuntime.transport.send).mockClear();
    await renderRuntime(nextRuntime, 'foreground-next-runtime');

    act(() => oldRuntime.resumeLastForegroundSubscriber());
    await flushAsyncCompletion();
    expect(oldRuntime.transport.send).not.toHaveBeenCalled();

    const unmountedRuntime = createRuntimeHarness({ online: true });
    await renderRuntime(unmountedRuntime, 'foreground-unmounted-runtime');
    await vi.waitFor(() =>
      expect(unmountedRuntime.transport.send).toHaveBeenCalledOnce(),
    );
    vi.mocked(unmountedRuntime.transport.send).mockClear();
    act(() => root?.unmount());
    root = undefined;

    act(() => unmountedRuntime.resumeLastForegroundSubscriber());
    await flushAsyncCompletion();
    expect(unmountedRuntime.transport.send).not.toHaveBeenCalled();
  });

  it.each([
    [
      'session rotation',
      { ...vaultScope, sessionEpoch: sessionFixtureIds.nextEpoch },
    ],
    [
      'Vault switch',
      { ...vaultScope, vaultId: sessionFixtureIds.otherVaultId },
    ],
  ] satisfies ReadonlyArray<readonly [string, VaultNotesScope]>)(
    'rejects a late load after %s',
    async (_label, nextScope) => {
      const oldLoad = Promise.withResolvers<CardRecord[]>();
      const oldCard = card('provider-old-load', 'old account content');
      const nextCard = card('provider-next-load', 'current account content');
      const oldRuntime = createRuntimeHarness({
        scope: vaultScope,
        loadCards: () => oldLoad.promise,
      });
      const nextRuntime = createRuntimeHarness({
        scope: nextScope,
        loadCards: async () => [nextCard],
      });

      await renderRuntime(oldRuntime, 'old-runtime');
      expect(oldRuntime.repository.loadCards).toHaveBeenCalledOnce();
      await renderRuntime(nextRuntime, 'next-runtime');
      expect(currentStore().cards).toEqual([nextCard]);

      oldLoad.resolve([oldCard]);
      await flushAsyncCompletion();

      expect(currentStore().cards).toEqual([nextCard]);
    },
  );

  it('does not apply a sync response that arrives after unmount', async () => {
    const response = Promise.withResolvers<unknown>();
    const runtime = createRuntimeHarness({
      online: true,
      send: () => response.promise,
    });

    await renderRuntime(runtime, 'sync-runtime');
    await vi.waitFor(() =>
      expect(runtime.transport.send).toHaveBeenCalledOnce(),
    );

    act(() => root?.unmount());
    root = undefined;
    response.resolve({ untrusted: 'late response' });
    await flushAsyncCompletion();

    expect(runtime.repository.applySyncResponse).not.toHaveBeenCalled();
  });

  it('stops operations in the layout phase before a purge fence releases', async () => {
    const response = Promise.withResolvers<unknown>();
    const runtime = createRuntimeHarness({
      online: true,
      send: () => response.promise,
    });

    await renderRuntime(runtime, 'fenced-sync-runtime');
    await vi.waitFor(() =>
      expect(runtime.transport.send).toHaveBeenCalledOnce(),
    );
    await renderRuntime(runtime, 'fenced-sync-runtime', true);
    expect(document.body.textContent).toContain('Runtime fenced');

    response.resolve({ untrusted: 'late fenced response' });
    await flushAsyncCompletion();

    expect(runtime.repository.applySyncResponse).not.toHaveBeenCalled();
  });

  it('drops queued saves and follow-up sync when an in-flight save outlives unmount', async () => {
    const firstSave = Promise.withResolvers<void>();
    const saveStarted = Promise.withResolvers<void>();
    let persistCalls = 0;
    const runtime = createRuntimeHarness({
      persistCardAndMutation: async (cardRecord) => {
        persistCalls += 1;
        if (persistCalls === 1) {
          saveStarted.resolve();
          await firstSave.promise;
        }
        return mutationFor(cardRecord);
      },
    });

    await renderRuntime(runtime, 'save-runtime');
    await act(async () => {
      await currentStore().createCard();
      await currentStore().createCard();
      await saveStarted.promise;
    });
    expect(runtime.repository.persistCardAndMutation).toHaveBeenCalledOnce();

    act(() => root?.unmount());
    root = undefined;
    firstSave.resolve();
    await flushAsyncCompletion();

    expect(runtime.repository.persistCardAndMutation).toHaveBeenCalledOnce();
    expect(runtime.transport.send).not.toHaveBeenCalled();
  });

  it('preserves an edit made while a current-session sync is in flight', async () => {
    const initialCard = card('provider-rebase', 'before request');
    const serverCard = {
      ...initialCard,
      title: 'server acknowledgement',
      updatedAt: 2_100,
      serverRevision: 2,
    };
    const response = Promise.withResolvers<unknown>();
    const runtime = createRuntimeHarness({
      online: true,
      loadCards: async () => [initialCard],
      send: () => response.promise,
      applySyncResponse: async () => ({ cards: [serverCard], conflicts: [] }),
    });

    await renderRuntime(runtime, 'rebase-runtime');
    await vi.waitFor(() =>
      expect(runtime.transport.send).toHaveBeenCalledOnce(),
    );
    act(() =>
      currentStore().updateCard(initialCard.id, {
        type: 'title',
        title: 'edit during request',
      }),
    );

    await act(async () => {
      response.resolve({});
      await flushAsyncCompletion();
    });

    expect(runtime.repository.applySyncResponse).toHaveBeenCalledOnce();
    expect(currentStore().cards).toEqual([
      expect.objectContaining({
        id: initialCard.id,
        title: 'edit during request',
        localRevision: 2,
      }),
    ]);
  });

  it('keeps conflict-time edits local until one card-level resolution is selected', async () => {
    const initialCard = card('provider-conflict-current', 'server title');
    const first: ConflictRecord = {
      id: fixtureConflictId('provider-conflict-first'),
      cardId: initialCard.id,
      serverRevision: 1,
      localTitle: 'first local',
      localBody: [],
      serverTitle: 'first server',
      serverBody: [],
      createdAt: 1_100,
    };
    const second: ConflictRecord = {
      ...first,
      id: fixtureConflictId('provider-conflict-second'),
      localTitle: 'second local',
      serverRevision: 2,
      createdAt: 1_200,
    };
    const runtime = createRuntimeHarness({
      loadCards: async () => [initialCard],
      loadConflicts: async () => [first, second],
    });

    await renderRuntime(runtime, 'conflict-current-runtime');
    act(() =>
      currentStore().updateCard(initialCard.id, {
        type: 'title',
        title: '現在入力を残す',
      }),
    );
    await vi.waitFor(() =>
      expect(runtime.repository.persistLocalCard).toHaveBeenCalledOnce(),
    );
    expect(runtime.repository.persistCardAndMutation).not.toHaveBeenCalled();

    act(() => {
      currentStore().resolveConflict(first, 'current');
    });
    await vi.waitFor(() =>
      expect(runtime.repository.persistCardAndMutation).toHaveBeenCalledOnce(),
    );
    expect(runtime.repository.persistCardAndMutation).toHaveBeenCalledWith(
      expect.objectContaining({
        id: initialCard.id,
        title: '現在入力を残す',
        serverRevision: 2,
      }),
      {
        kind: 'resolve',
        conflictIds: [first.id, second.id],
      },
    );
    expect(currentStore().resolvingConflictCardIds).toEqual([initialCard.id]);
  });

  it('reconciles v2 replica results without routing them through the v1 decoder', async () => {
    const initialCard = card('provider-v2-rebase', 'before v2 request');
    const serverCard = {
      ...initialCard,
      title: 'v2 server acknowledgement',
      updatedAt: 2_100,
      serverRevision: 2,
    };
    const response = Promise.withResolvers<SyncV2ClientResult>();
    const client: SyncV2Client<VaultNotesScope> = {
      scope: vaultScope,
      synchronize: vi.fn(async () => response.promise),
    };
    const runtime = createV2RuntimeHarness(client, {
      online: true,
      loadCards: async () => [initialCard],
    });

    await renderRuntime(runtime, 'v2-rebase-runtime');
    await vi.waitFor(() => expect(client.synchronize).toHaveBeenCalledOnce());
    act(() =>
      currentStore().updateCard(initialCard.id, {
        type: 'title',
        title: 'edit during v2 request',
      }),
    );

    await act(async () => {
      response.resolve({
        kind: 'completed',
        cards: [serverCard],
        conflicts: [],
      });
      await flushAsyncCompletion();
    });

    expect(runtime.repository.applySyncResponse).not.toHaveBeenCalled();
    expect(currentStore().cards).toEqual([
      expect.objectContaining({
        id: initialCard.id,
        title: 'edit during v2 request',
        localRevision: 2,
        serverRevision: 2,
      }),
    ]);
  });

  it('removes an unchanged card omitted by a completed v2 replica commit', async () => {
    const deletedCard = card('provider-v2-deleted', 'deleted remotely');
    const response = Promise.withResolvers<SyncV2ClientResult>();
    const client: SyncV2Client<VaultNotesScope> = {
      scope: vaultScope,
      synchronize: vi.fn(async () => response.promise),
    };
    const runtime = createV2RuntimeHarness(client, {
      online: true,
      loadCards: async () => [deletedCard],
    });

    await renderRuntime(runtime, 'v2-delete-runtime');
    await vi.waitFor(() => expect(client.synchronize).toHaveBeenCalledOnce());

    await act(async () => {
      response.resolve({ kind: 'completed', cards: [], conflicts: [] });
      await flushAsyncCompletion();
    });

    expect(currentStore().cards).toEqual([]);
  });

  it('retains a card edited while a v2 deletion response is in flight', async () => {
    const editedCard = card('provider-v2-delete-race', 'before request');
    const response = Promise.withResolvers<SyncV2ClientResult>();
    const client: SyncV2Client<VaultNotesScope> = {
      scope: vaultScope,
      synchronize: vi.fn(async () => response.promise),
    };
    const runtime = createV2RuntimeHarness(client, {
      online: true,
      loadCards: async () => [editedCard],
    });

    await renderRuntime(runtime, 'v2-delete-race-runtime');
    await vi.waitFor(() => expect(client.synchronize).toHaveBeenCalledOnce());
    act(() =>
      currentStore().updateCard(editedCard.id, {
        type: 'title',
        title: 'edited during delete request',
      }),
    );

    await act(async () => {
      response.resolve({ kind: 'completed', cards: [], conflicts: [] });
      await flushAsyncCompletion();
    });

    expect(currentStore().cards).toEqual([
      expect.objectContaining({
        id: editedCard.id,
        title: 'edited during delete request',
        localRevision: 2,
      }),
    ]);
  });

  it('prevents a v2 terminal replica commit after the logout fence activates', async () => {
    const terminalResponse = Promise.withResolvers<unknown>();
    const send = vi.fn(async () => terminalResponse.promise);
    const applyCommit = vi.fn(async () => ({
      kind: 'applied' as const,
      checkpoint: {
        cursor: parseSyncV2Cursor(
          'sync.v2.provider.commit.aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        ),
        highWatermark: parseSyncSequence(0),
      },
      cards: [],
      conflicts: [],
    }));
    const client = createSyncV2Client({
      scope: vaultScope,
      transport: {
        scope: vaultScope,
        send,
      },
      replica: {
        scope: vaultScope,
        loadCheckpoint: vi.fn(async () => initialSyncV2Checkpoint()),
        applyCommit,
      },
    });
    const runtime = createV2RuntimeHarness(client, { online: true });

    await renderRuntime(runtime, 'v2-fenced-runtime');
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    await renderRuntime(runtime, 'v2-fenced-runtime', true);

    await act(async () => {
      terminalResponse.resolve({
        version: SYNC_V2_VERSION,
        highWatermark: 0,
        changes: [],
        receipts: [],
        page: {
          kind: 'complete',
          nextCursor: 'sync.v2.provider.commit.aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        },
      });
      await flushAsyncCompletion();
    });

    expect(applyCommit).not.toHaveBeenCalled();
  });
});
