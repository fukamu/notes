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
  createCardId,
  type CardId,
  type ConflictId,
  type DeviceId,
} from '@/lib/domain/id';
import {
  nextProvisionalValue,
  reconcileProvisionalDisplayIds,
} from '@/lib/domain/display-id';
import {
  nonNegativeSafeInteger,
  positiveSafeInteger,
  type BodySegment,
  type CardRecord,
  type ConflictRecord,
  type SaveState,
  type SyncState,
} from '@/lib/domain/types';
import {
  applySyncResponse,
  loadCards,
  loadConflicts,
  loadOrCreateDeviceId,
  loadPendingMutations,
  persistCardAndMutation,
} from '@/lib/storage/indexed-db';
import { encodeSyncRequest } from '@/lib/sync/protocol';
import { prepareOfflineApp } from '@/lib/client/offline';

export type NotesDataStore = {
  cards: CardRecord[];
  conflicts: ConflictRecord[];
  initialized: boolean;
  saveState: SaveState;
  syncState: SyncState;
  createCard: () => Promise<CardRecord>;
  updateCard: (
    cardId: CardId,
    patch: { title?: string; body?: BodySegment[] },
  ) => void;
  synchronizeNow: () => Promise<void>;
  resolveConflict: (
    conflict: ConflictRecord,
    choice: 'local' | 'server',
  ) => CardRecord | undefined;
};

const NotesDataContext = createContext<NotesDataStore | null>(null);

export function NotesProvider({ children }: { children: ReactNode }) {
  const [cards, setCards] = useState<CardRecord[]>([]);
  const [conflicts, setConflicts] = useState<ConflictRecord[]>([]);
  const [initialized, setInitialized] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [syncState, setSyncState] = useState<SyncState>('idle');
  const cardsRef = useRef(cards);
  const deviceIdRef = useRef<DeviceId | undefined>(undefined);
  const syncRunningRef = useRef(false);
  const syncRequestedRef = useRef(false);
  const syncTimerRef = useRef<number | undefined>(undefined);
  const saveSequenceRef = useRef(0);
  const saveQueueRef = useRef(Promise.resolve());

  useEffect(() => {
    cardsRef.current = cards;
  }, [cards]);

  const synchronizeNow = useCallback(async () => {
    if (!initialized) return;
    if (syncRunningRef.current) {
      syncRequestedRef.current = true;
      return;
    }
    if (!navigator.onLine) {
      setSyncState('offline');
      return;
    }

    syncRunningRef.current = true;
    setSyncState('syncing');
    try {
      do {
        syncRequestedRef.current = false;
        const deviceId = deviceIdRef.current ?? (await loadOrCreateDeviceId());
        deviceIdRef.current = deviceId;
        const mutations = await loadPendingMutations();
        const revisionsAtRequest = new Map(
          cardsRef.current.map((card) => [card.id, card.localRevision]),
        );
        const requestBody = encodeSyncRequest({ deviceId, mutations });
        const response = await fetch('/api/sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });
        if (!response.ok) throw new Error(`sync returned ${response.status}`);
        const result: unknown = await response.json();
        const merged = await applySyncResponse(result, mutations);
        const latestLocalCards = new Map(
          cardsRef.current.map((card) => [card.id, card]),
        );
        const visibleCards = merged.cards.map((mergedCard) => {
          const latestLocal = latestLocalCards.get(mergedCard.id);
          const revisionAtRequest = revisionsAtRequest.get(mergedCard.id);
          if (
            !latestLocal ||
            revisionAtRequest === undefined ||
            latestLocal.localRevision <= revisionAtRequest
          ) {
            return mergedCard;
          }
          latestLocalCards.delete(mergedCard.id);
          return {
            ...latestLocal,
            displayId: mergedCard.displayId,
            serverRevision: mergedCard.serverRevision,
          };
        });
        for (const latestLocal of latestLocalCards.values()) {
          if (!visibleCards.some((card) => card.id === latestLocal.id)) {
            visibleCards.push(latestLocal);
          }
        }
        cardsRef.current = visibleCards;
        setCards(visibleCards);
        setConflicts(merged.conflicts);
      } while (syncRequestedRef.current && navigator.onLine);
      setSyncState('idle');
    } catch (error) {
      console.error(error);
      setSyncState(navigator.onLine ? 'failed' : 'offline');
    } finally {
      syncRunningRef.current = false;
    }
  }, [initialized]);

  useEffect(() => {
    let active = true;
    void Promise.all([loadCards(), loadConflicts(), loadOrCreateDeviceId()])
      .then(([storedCards, storedConflicts, deviceId]) => {
        if (!active) return;
        const reconciled = reconcileProvisionalDisplayIds(storedCards);
        cardsRef.current = reconciled;
        deviceIdRef.current = deviceId;
        setCards(reconciled);
        setConflicts(storedConflicts);
        setSyncState(navigator.onLine ? 'idle' : 'offline');
        setInitialized(true);
      })
      .catch((error) => {
        console.error(error);
        if (active) {
          setSaveState('failed');
          setInitialized(true);
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!initialized) return;
    const initialSync = window.setTimeout(() => void synchronizeNow(), 0);
    const onOnline = () => void synchronizeNow();
    const onOffline = () => setSyncState('offline');
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    const timer = window.setInterval(() => void synchronizeNow(), 15_000);
    return () => {
      window.clearTimeout(initialSync);
      if (syncTimerRef.current !== undefined)
        window.clearTimeout(syncTimerRef.current);
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      window.clearInterval(timer);
    };
  }, [initialized, synchronizeNow]);

  useEffect(() => {
    void prepareOfflineApp().catch((error) => console.error(error));
  }, []);

  const queueSave = useCallback(
    (
      card: CardRecord,
      options:
        | { kind: 'upsert' }
        | { kind: 'resolve'; conflictIds: [ConflictId, ...ConflictId[]] } = {
        kind: 'upsert',
      },
    ) => {
      const sequence = ++saveSequenceRef.current;
      setSaveState('saving');
      saveQueueRef.current = saveQueueRef.current
        .then(() => {
          const latestCard = cardsRef.current.find(
            (candidate) => candidate.id === card.id,
          );
          return persistCardAndMutation(latestCard ?? card, options);
        })
        .then(() => {
          if (sequence === saveSequenceRef.current) setSaveState('saved');
          if (syncTimerRef.current !== undefined)
            window.clearTimeout(syncTimerRef.current);
          syncTimerRef.current = window.setTimeout(
            () => void synchronizeNow(),
            250,
          );
        })
        .catch((error) => {
          console.error(error);
          setSaveState('failed');
        });
    },
    [synchronizeNow],
  );

  const createCard = useCallback(async () => {
    const now = nonNegativeSafeInteger(Date.now(), 'card timestamp');
    const card: CardRecord = {
      id: createCardId(),
      displayId: {
        kind: 'provisional',
        value: positiveSafeInteger(
          nextProvisionalValue(cardsRef.current),
          'provisional display ID',
        ),
      },
      title: '',
      body: [],
      createdAt: now,
      updatedAt: now,
      localRevision: positiveSafeInteger(1, 'initial local revision'),
      serverRevision: null,
    };
    const nextCards = [...cardsRef.current, card];
    cardsRef.current = nextCards;
    setCards(nextCards);
    queueSave(card);
    return card;
  }, [queueSave]);

  const updateCard = useCallback(
    (cardId: CardId, patch: { title?: string; body?: BodySegment[] }) => {
      const existing = cardsRef.current.find((card) => card.id === cardId);
      if (!existing) return;
      const updated: CardRecord = {
        ...existing,
        ...patch,
        updatedAt: nonNegativeSafeInteger(Date.now(), 'card timestamp'),
        localRevision: positiveSafeInteger(
          existing.localRevision + 1,
          'local revision',
        ),
      };
      const nextCards = cardsRef.current.map((card) =>
        card.id === cardId ? updated : card,
      );
      cardsRef.current = nextCards;
      setCards(nextCards);
      queueSave(updated);
    },
    [queueSave],
  );

  const resolveConflict = useCallback(
    (conflict: ConflictRecord, choice: 'local' | 'server') => {
      const existing = cardsRef.current.find(
        (card) => card.id === conflict.cardId,
      );
      if (!existing) return undefined;
      const updated: CardRecord = {
        ...existing,
        title: choice === 'local' ? conflict.localTitle : conflict.serverTitle,
        body: choice === 'local' ? conflict.localBody : conflict.serverBody,
        serverRevision: conflict.serverRevision,
        updatedAt: nonNegativeSafeInteger(Date.now(), 'card timestamp'),
        localRevision: positiveSafeInteger(
          existing.localRevision + 1,
          'local revision',
        ),
      };
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
    [queueSave],
  );

  const value = useMemo<NotesDataStore>(
    () => ({
      cards,
      conflicts,
      initialized,
      saveState,
      syncState,
      createCard,
      updateCard,
      synchronizeNow,
      resolveConflict,
    }),
    [
      cards,
      conflicts,
      initialized,
      saveState,
      syncState,
      createCard,
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

export function useNotesDataStore(): NotesDataStore {
  const value = useContext(NotesDataContext);
  if (!value) {
    throw new Error('useNotesDataStore must be used inside NotesProvider');
  }
  return value;
}
