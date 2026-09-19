'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  INITIAL_NOTES_INITIALIZATION,
  isNotesInitialized,
  transitionNotesInitialization,
  type NotesInitializationLifecycle,
} from '@/lib/application/initialization-lifecycle';
import {
  activateNotesOperationLifecycle,
  captureNotesOperation,
  createStoppedNotesOperationLifecycle,
  decideNotesOperationContinuation,
  stopNotesOperationLifecycle,
  type NotesOperationLifecycle,
  type NotesOperationToken,
} from '@/lib/application/notes-operation-lifecycle';
import type { NotesRuntimePorts } from '@/lib/application/notes-runtime';
import { type CardId, type ConflictId, type DeviceId } from '@/lib/domain/id';
import { reconcileProvisionalDisplayIds } from '@/lib/domain/display-id';
import {
  applyCardEdit,
  createLocalCard,
  resolveCardConflicts,
  type CardEdit,
  type ConflictResolutionChoice,
} from '@/lib/domain/card-transitions';
import {
  type CardRecord,
  type ConflictRecord,
  type SaveState,
  type SyncState,
} from '@/lib/domain/types';
import { encodeSyncRequest } from '@/lib/sync/protocol';
import { reconcileVisibleCardsAfterSync } from '@/lib/sync/client-reconciliation';
import { assertNever } from '@/lib/shared/invariant';

export type NotesDataStore = {
  cards: CardRecord[];
  conflicts: ConflictRecord[];
  initialization: NotesInitializationLifecycle;
  saveState: SaveState;
  syncState: SyncState;
  resolvingConflictCardIds: CardId[];
  createCard: () => Promise<CardRecord>;
  hasCard: (cardId: CardId) => boolean;
  updateCard: (cardId: CardId, edit: CardEdit) => void;
  synchronizeNow: () => Promise<void>;
  resolveConflict: (
    conflict: ConflictRecord,
    choice: ConflictResolutionChoice,
  ) => CardRecord | undefined;
};

const NotesDataContext = createContext<NotesDataStore | null>(null);

export function NotesProvider({
  children,
  ports,
  fenced = false,
  fencedFallback = null,
}: {
  children: ReactNode;
  ports: NotesRuntimePorts;
  fenced?: boolean;
  fencedFallback?: ReactNode;
}) {
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [initialization, setInitialization] =
    useState<NotesInitializationLifecycle>(INITIAL_NOTES_INITIALIZATION);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const [resolvingConflictCardIds, setResolvingConflictCardIds] = useState<
    CardId[]
  >([]);
  const cardsRef = useRef(cards);
  const conflictsRef = useRef(conflicts);
  const resolvingConflictCardIdsRef = useRef(resolvingConflictCardIds);
  const operationLifecycleRef = useRef(
    createStoppedNotesOperationLifecycle(ports.scope),
  );
  const deviceIdRef = useRef<DeviceId | undefined>(undefined);
  const syncRunningRef = useRef<NotesOperationToken | undefined>(undefined);
  const syncRequestedRef = useRef(false);
  const syncTimerRef = useRef<number | undefined>(undefined);
  const saveSequenceRef = useRef(0);
  const localQueueRef = useRef(Promise.resolve());
  const initialized = isNotesInitialized(initialization);

  useEffect(() => {
    operationLifecycleRef.current = activateNotesOperationLifecycle(
      operationLifecycleRef.current,
      ports.scope,
    );
    deviceIdRef.current = undefined;
    syncRunningRef.current = undefined;
    syncRequestedRef.current = false;
    saveSequenceRef.current = 0;
    localQueueRef.current = Promise.resolve();
    resolvingConflictCardIdsRef.current = [];

    return () => {
      operationLifecycleRef.current = stopNotesOperationLifecycle(
        operationLifecycleRef.current,
      );
    };
  }, [ports]);

  useLayoutEffect(() => {
    if (!fenced) return;
    operationLifecycleRef.current = stopNotesOperationLifecycle(
      operationLifecycleRef.current,
    );
    syncRunningRef.current = undefined;
    syncRequestedRef.current = false;
    if (syncTimerRef.current !== undefined) {
      window.clearTimeout(syncTimerRef.current);
      syncTimerRef.current = undefined;
    }
  }, [fenced]);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  useEffect(() => {
    conflictsRef.current = conflicts;
  }, [conflicts]);

  useEffect(() => {
    resolvingConflictCardIdsRef.current = resolvingConflictCardIds;
  }, [resolvingConflictCardIds]);

  const enqueueLocalOperation = useCallback(
    <T,>(operation: () => Promise<T>): Promise<T> => {
      const result = localQueueRef.current.then(operation);
      localQueueRef.current = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
    [],
  );

  const publishSynchronizedReplica = useCallback(
    (input: {
      readonly cards: readonly CardRecord[];
      readonly conflicts: readonly ConflictRecord[];
      readonly revisionsAtRequest: ReadonlyMap<CardId, number>;
    }) => {
      const visibleCards = reconcileVisibleCardsAfterSync({
        currentCards: cardsRef.current,
        revisionsAtRequest: input.revisionsAtRequest,
        mergedCards: input.cards,
      });
      const nextConflicts = [...input.conflicts];
      cardsRef.current = visibleCards;
      conflictsRef.current = nextConflicts;
      setCards(visibleCards);
      setConflicts(nextConflicts);
      const unresolvedCardIds = new Set(
        input.conflicts.map((conflict) => conflict.cardId),
      );
      const nextResolvingConflictCardIds =
        resolvingConflictCardIdsRef.current.filter((cardId) =>
          unresolvedCardIds.has(cardId),
        );
      resolvingConflictCardIdsRef.current = nextResolvingConflictCardIds;
      setResolvingConflictCardIds(nextResolvingConflictCardIds);
    },
    [],
  );

  const synchronizeNow = useCallback(async () => {
    if (!initialized) return;
    const capture = captureNotesOperation(
      operationLifecycleRef.current,
      'sync',
    );
    if (capture.kind === 'rejected') return;
    const operationToken = capture.token;
    const runningOperation = syncRunningRef.current;
    if (
      runningOperation !== undefined &&
      decideNotesOperationContinuation(
        operationLifecycleRef.current,
        runningOperation,
      ).kind === 'accepted'
    ) {
      syncRequestedRef.current = true;
      return;
    }
    if (!ports.connectivity.isOnline()) {
      setSyncState('offline');
      return;
    }

    syncRunningRef.current = operationToken;
    syncRequestedRef.current = false;
    setSyncState('syncing');
    try {
      do {
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return;
        syncRequestedRef.current = false;
        const deviceId =
          deviceIdRef.current ??
          (await ports.repository.loadOrCreateDeviceId());
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return;
        deviceIdRef.current = deviceId;
        const snapshotResult = await enqueueLocalOperation(async () => {
          if (
            !operationIsCurrent(operationLifecycleRef.current, operationToken)
          ) {
            return { kind: 'cancelled' as const };
          }
          const snapshot = await ports.repository.loadSyncRequestSnapshot();
          if (
            !operationIsCurrent(operationLifecycleRef.current, operationToken)
          ) {
            return { kind: 'cancelled' as const };
          }
          return { kind: 'captured' as const, snapshot };
        });
        if (snapshotResult.kind === 'cancelled') return;
        const { sentMutations, revisionsAtRequest } = snapshotResult.snapshot;
        switch (ports.sync.kind) {
          case 'v1': {
            const requestBody = encodeSyncRequest({
              deviceId,
              mutations: [...sentMutations],
            });
            const result = await ports.sync.transport.send(requestBody);
            // A stale response must never reach the mutation ack boundary.
            if (
              !operationIsCurrent(operationLifecycleRef.current, operationToken)
            )
              return;
            const commit = await enqueueLocalOperation(async () => {
              if (
                !operationIsCurrent(
                  operationLifecycleRef.current,
                  operationToken,
                )
              ) {
                return { kind: 'cancelled' as const };
              }
              const merged = await ports.repository.applySyncResponse(result, [
                ...sentMutations,
              ]);
              if (
                !operationIsCurrent(
                  operationLifecycleRef.current,
                  operationToken,
                )
              ) {
                return { kind: 'cancelled' as const };
              }
              publishSynchronizedReplica({
                ...merged,
                revisionsAtRequest,
              });
              return { kind: 'applied' as const };
            });
            if (commit.kind === 'cancelled') return;
            break;
          }
          case 'v2': {
            const result = await ports.sync.client.synchronize({
              deviceId,
              sentMutations,
              isCurrent: () =>
                operationIsCurrent(
                  operationLifecycleRef.current,
                  operationToken,
                ),
              executeCommit: (commit) =>
                enqueueLocalOperation(async () => {
                  if (
                    !operationIsCurrent(
                      operationLifecycleRef.current,
                      operationToken,
                    )
                  ) {
                    return { kind: 'cancelled' as const };
                  }
                  const committed = await commit();
                  if (
                    !operationIsCurrent(
                      operationLifecycleRef.current,
                      operationToken,
                    )
                  ) {
                    return { kind: 'cancelled' as const };
                  }
                  switch (committed.kind) {
                    case 'applied':
                    case 'already-applied':
                      publishSynchronizedReplica({
                        cards: committed.cards,
                        conflicts: committed.conflicts,
                        revisionsAtRequest,
                      });
                      break;
                    case 'rejected':
                      break;
                    default:
                      return assertNever(
                        committed,
                        'Unsupported Sync v2 repository commit result',
                      );
                  }
                  return committed;
                }),
            });
            switch (result.kind) {
              case 'cancelled':
                return;
              case 'rejected':
                throw new Error(`Sync v2 rejected: ${result.reason}`);
              case 'completed':
                break;
              default:
                return assertNever(result, 'Unsupported Sync v2 client result');
            }
            break;
          }
          default:
            return assertNever(ports.sync, 'Unsupported notes sync runtime');
        }
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return;
      } while (
        operationIsCurrent(operationLifecycleRef.current, operationToken) &&
        syncRequestedRef.current &&
        ports.connectivity.isOnline()
      );
      if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
        return;
      setSyncState('idle');
    } catch (error) {
      if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
        return;
      console.error(error);
      setSyncState(ports.connectivity.isOnline() ? 'failed' : 'offline');
    } finally {
      if (syncRunningRef.current === operationToken) {
        syncRunningRef.current = undefined;
      }
    }
  }, [
    enqueueLocalOperation,
    initialized,
    ports.connectivity,
    ports.repository,
    ports.sync,
    publishSynchronizedReplica,
  ]);

  useEffect(() => {
    const capture = captureNotesOperation(
      operationLifecycleRef.current,
      'load',
    );
    if (capture.kind === 'rejected') return;
    const operationToken = capture.token;
    void Promise.all([
      ports.repository.loadCards(),
      ports.repository.loadConflicts(),
      ports.repository.loadOrCreateDeviceId(),
      ports.repository.loadPendingMutations(),
    ])
      .then(([storedCards, storedConflicts, deviceId, storedMutations]) => {
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return;
        const reconciled = reconcileProvisionalDisplayIds(storedCards);
        cardsRef.current = reconciled;
        conflictsRef.current = storedConflicts;
        deviceIdRef.current = deviceId;
        setCards(reconciled);
        setConflicts(storedConflicts);
        const resolvingCardIds = [
          ...new Set(
            storedMutations
              .filter((mutation) => mutation.kind === 'resolve')
              .map((mutation) => mutation.cardId),
          ),
        ];
        resolvingConflictCardIdsRef.current = resolvingCardIds;
        setResolvingConflictCardIds(resolvingCardIds);
        setSyncState(ports.connectivity.isOnline() ? 'idle' : 'offline');
        setInitialization((lifecycle) =>
          transitionNotesInitialization(lifecycle, {
            type: 'load-completed',
            outcome: 'succeeded',
          }),
        );
      })
      .catch((error) => {
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return;
        console.error(error);
        setSaveState('failed');
        setInitialization((lifecycle) =>
          transitionNotesInitialization(lifecycle, {
            type: 'load-completed',
            outcome: 'failed',
          }),
        );
      });
  }, [ports.connectivity, ports.repository]);

  useEffect(() => {
    if (!initialized) return;
    const capture = captureNotesOperation(
      operationLifecycleRef.current,
      'sync',
    );
    if (capture.kind === 'rejected') return;
    const operationToken = capture.token;
    const initialSync = window.setTimeout(() => {
      void synchronizeNow().finally(() => {
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return;
        setInitialization((lifecycle) =>
          transitionNotesInitialization(lifecycle, {
            type: 'initial-sync-completed',
          }),
        );
      });
    }, 0);
    const onOnline = () => void synchronizeNow();
    const onOffline = () => setSyncState('offline');
    const unsubscribeConnectivity = ports.connectivity.subscribe({
      onOnline,
      onOffline,
    });
    const unsubscribeForeground = ports.foregroundResume.subscribe(() => {
      if (!operationIsCurrent(operationLifecycleRef.current, operationToken)) {
        return;
      }
      void synchronizeNow();
    });
    const timer = window.setInterval(() => void synchronizeNow(), 15_000);
    return () => {
      window.clearTimeout(initialSync);
      if (syncTimerRef.current !== undefined)
        window.clearTimeout(syncTimerRef.current);
      unsubscribeConnectivity();
      unsubscribeForeground();
      window.clearInterval(timer);
    };
  }, [initialized, ports.connectivity, ports.foregroundResume, synchronizeNow]);

  useEffect(() => {
    void ports.offlineApp.prepare().catch((error) => console.error(error));
  }, [ports.offlineApp]);

  const queueSave = useCallback(
    (
      card: CardRecord,
      options:
        | { kind: 'local-only' }
        | { kind: 'upsert' }
        | { kind: 'resolve'; conflictIds: [ConflictId, ...ConflictId[]] } = {
        kind: 'upsert',
      },
    ) => {
      const capture = captureNotesOperation(
        operationLifecycleRef.current,
        'save',
      );
      if (capture.kind === 'rejected') return;
      const operationToken = capture.token;
      const sequence = ++saveSequenceRef.current;
      setSaveState('saving');
      void enqueueLocalOperation(async () => {
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return { operationAccepted: false, shouldSync: false };
        const latestCard = cardsRef.current.find(
          (candidate) => candidate.id === card.id,
        );
        const hasUnresolvedConflict = conflictsRef.current.some(
          (conflict) => conflict.cardId === card.id,
        );
        const resolutionIsPending =
          resolvingConflictCardIdsRef.current.includes(card.id);
        const effectiveOptions =
          options.kind === 'upsert' &&
          hasUnresolvedConflict &&
          !resolutionIsPending
            ? ({ kind: 'local-only' } as const)
            : options;
        if (effectiveOptions.kind === 'local-only') {
          await ports.repository.persistLocalCard(latestCard ?? card);
        } else {
          await ports.repository.persistCardAndMutation(
            latestCard ?? card,
            effectiveOptions,
          );
        }
        return {
          operationAccepted: operationIsCurrent(
            operationLifecycleRef.current,
            operationToken,
          ),
          shouldSync: effectiveOptions.kind !== 'local-only',
        };
      })
        .then(({ operationAccepted, shouldSync }) => {
          if (!operationAccepted) return;
          if (sequence === saveSequenceRef.current) setSaveState('saved');
          if (shouldSync) {
            if (syncTimerRef.current !== undefined)
              window.clearTimeout(syncTimerRef.current);
            syncTimerRef.current = window.setTimeout(
              () => void synchronizeNow(),
              250,
            );
          }
        })
        .catch((error) => {
          if (
            !operationIsCurrent(operationLifecycleRef.current, operationToken)
          )
            return;
          console.error(error);
          setSaveState('failed');
        });
    },
    [enqueueLocalOperation, ports.repository, synchronizeNow],
  );

  const createCard = useCallback(async () => {
    const now = ports.clock.now();
    const card = createLocalCard({
      cards: cardsRef.current,
      cardId: ports.idGenerator.createCardId(),
      now,
    });
    const nextCards = [...cardsRef.current, card];
    cardsRef.current = nextCards;
    setCards(nextCards);
    queueSave(card);
    return card;
  }, [ports.clock, ports.idGenerator, queueSave]);

  const updateCard = useCallback(
    (cardId: CardId, edit: CardEdit) => {
      const existing = cardsRef.current.find((card) => card.id === cardId);
      if (!existing) return;
      const updated = applyCardEdit(existing, edit, ports.clock.now());
      const nextCards = cardsRef.current.map((card) =>
        card.id === cardId ? updated : card,
      );
      cardsRef.current = nextCards;
      setCards(nextCards);
      const hasUnresolvedConflict = conflictsRef.current.some(
        (conflict) => conflict.cardId === cardId,
      );
      const resolutionIsPending =
        resolvingConflictCardIdsRef.current.includes(cardId);
      queueSave(
        updated,
        hasUnresolvedConflict && !resolutionIsPending
          ? { kind: 'local-only' }
          : { kind: 'upsert' },
      );
    },
    [ports.clock, queueSave],
  );

  const hasCard = useCallback(
    (cardId: CardId) => cardsRef.current.some((card) => card.id === cardId),
    [],
  );

  const resolveConflict = useCallback(
    (conflict: ConflictRecord, choice: ConflictResolutionChoice) => {
      const existing = cardsRef.current.find(
        (card) => card.id === conflict.cardId,
      );
      if (!existing) return undefined;
      const cardConflicts = conflictsRef.current.filter(
        (candidate) => candidate.cardId === conflict.cardId,
      );
      const result = resolveCardConflicts(
        existing,
        cardConflicts,
        conflict.id,
        choice,
        ports.clock.now(),
      );
      if (!result.ok) return undefined;
      const updated = result.card;
      const nextCards = cardsRef.current.map((card) =>
        card.id === conflict.cardId ? updated : card,
      );
      cardsRef.current = nextCards;
      setCards(nextCards);
      if (!resolvingConflictCardIdsRef.current.includes(conflict.cardId)) {
        const nextResolving = [
          ...resolvingConflictCardIdsRef.current,
          conflict.cardId,
        ];
        resolvingConflictCardIdsRef.current = nextResolving;
        setResolvingConflictCardIds(nextResolving);
      }
      queueSave(updated, {
        kind: 'resolve',
        conflictIds: result.conflictIds,
      });
      return updated;
    },
    [ports.clock, queueSave],
  );

  const value = useMemo<NotesDataStore>(
    () => ({
      cards,
      conflicts,
      initialization,
      saveState,
      syncState,
      resolvingConflictCardIds,
      createCard,
      hasCard,
      updateCard,
      synchronizeNow,
      resolveConflict,
    }),
    [
      cards,
      conflicts,
      initialization,
      saveState,
      syncState,
      resolvingConflictCardIds,
      createCard,
      hasCard,
      updateCard,
      synchronizeNow,
      resolveConflict,
    ],
  );

  return (
    <NotesDataContext.Provider value={value}>
      {fenced ? fencedFallback : children}
    </NotesDataContext.Provider>
  );
}

function operationIsCurrent(
  lifecycle: NotesOperationLifecycle,
  token: NotesOperationToken,
): boolean {
  return decideNotesOperationContinuation(lifecycle, token).kind === 'accepted';
}

export function useNotesDataStore(): NotesDataStore {
  const value = useContext(NotesDataContext);
  if (!value) {
    throw new Error('useNotesDataStore must be used inside NotesProvider');
  }
  return value;
}
