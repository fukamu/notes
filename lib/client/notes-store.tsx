'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
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
  resolveCardConflict,
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

export type NotesDataStore = {
  cards: CardRecord[];
  conflicts: ConflictRecord[];
  initialization: NotesInitializationLifecycle;
  saveState: SaveState;
  syncState: SyncState;
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
}: {
  children: ReactNode;
  ports: NotesRuntimePorts;
}) {
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [initialization, setInitialization] =
    useState<NotesInitializationLifecycle>(INITIAL_NOTES_INITIALIZATION);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const cardsRef = useRef(cards);
  const operationLifecycleRef = useRef(
    createStoppedNotesOperationLifecycle(ports.scope),
  );
  const deviceIdRef = useRef<DeviceId | undefined>(undefined);
  const syncRunningRef = useRef<NotesOperationToken | undefined>(undefined);
  const syncRequestedRef = useRef(false);
  const syncTimerRef = useRef<number | undefined>(undefined);
  const saveSequenceRef = useRef(0);
  const saveQueueRef = useRef(Promise.resolve());
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
    saveQueueRef.current = Promise.resolve();

    return () => {
      operationLifecycleRef.current = stopNotesOperationLifecycle(
        operationLifecycleRef.current,
      );
    };
  }, [ports]);

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

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
        const mutations = await ports.repository.loadPendingMutations();
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return;
        const revisionsAtRequest = new Map(
          cardsRef.current.map((card) => [card.id, card.localRevision]),
        );
        const requestBody = encodeSyncRequest({ deviceId, mutations });
        const result = await ports.syncTransport.send(requestBody);
        // A stale response must never reach the mutation ack/cursor boundary.
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return;
        const merged = await ports.repository.applySyncResponse(
          result,
          mutations,
        );
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return;
        const visibleCards = reconcileVisibleCardsAfterSync({
          currentCards: cardsRef.current,
          revisionsAtRequest,
          mergedCards: merged.cards,
        });
        cardsRef.current = visibleCards;
        setCards(visibleCards);
        setConflicts(merged.conflicts);
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
  }, [initialized, ports.connectivity, ports.repository, ports.syncTransport]);

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
    ])
      .then(([storedCards, storedConflicts, deviceId]) => {
        if (!operationIsCurrent(operationLifecycleRef.current, operationToken))
          return;
        const reconciled = reconcileProvisionalDisplayIds(storedCards);
        cardsRef.current = reconciled;
        deviceIdRef.current = deviceId;
        setCards(reconciled);
        setConflicts(storedConflicts);
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
    const timer = window.setInterval(() => void synchronizeNow(), 15_000);
    return () => {
      window.clearTimeout(initialSync);
      if (syncTimerRef.current !== undefined)
        window.clearTimeout(syncTimerRef.current);
      unsubscribeConnectivity();
      window.clearInterval(timer);
    };
  }, [initialized, ports.connectivity, synchronizeNow]);

  useEffect(() => {
    void ports.offlineApp.prepare().catch((error) => console.error(error));
  }, [ports.offlineApp]);

  const queueSave = useCallback(
    (
      card: CardRecord,
      options:
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
      saveQueueRef.current = saveQueueRef.current
        .then(async () => {
          if (
            !operationIsCurrent(operationLifecycleRef.current, operationToken)
          )
            return false;
          const latestCard = cardsRef.current.find(
            (candidate) => candidate.id === card.id,
          );
          await ports.repository.persistCardAndMutation(
            latestCard ?? card,
            options,
          );
          return operationIsCurrent(
            operationLifecycleRef.current,
            operationToken,
          );
        })
        .then((operationAccepted) => {
          if (!operationAccepted) return;
          if (sequence === saveSequenceRef.current) setSaveState('saved');
          if (syncTimerRef.current !== undefined)
            window.clearTimeout(syncTimerRef.current);
          syncTimerRef.current = window.setTimeout(
            () => void synchronizeNow(),
            250,
          );
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
    [ports.repository, synchronizeNow],
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
      queueSave(updated);
    },
    [ports.clock, queueSave],
  );

  const hasCard = useCallback(
    (cardId: CardId) => cardsRef.current.some((card) => card.id === cardId),
    [],
  );

  const resolveConflict = useCallback(
    (conflict: ConflictRecord, choice: 'local' | 'server') => {
      const existing = cardsRef.current.find(
        (card) => card.id === conflict.cardId,
      );
      if (!existing) return undefined;
      const result = resolveCardConflict(
        existing,
        conflict,
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
      queueSave(updated, {
        kind: 'resolve',
        conflictIds: [conflict.id],
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
      createCard,
      hasCard,
      updateCard,
      synchronizeNow,
      resolveConflict,
    ],
  );

  return (
    <NotesDataContext.Provider value={value}>
      {children}
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
