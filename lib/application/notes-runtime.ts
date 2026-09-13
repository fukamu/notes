import type { PendingMutationMode } from '@/lib/domain/card-transitions';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import type { CardId, DeviceId, MutationId } from '@/lib/domain/id';
import type {
  CardRecord,
  ConflictRecord,
  PendingMutation,
} from '@/lib/domain/types';
import type { SyncRequestWire } from '@/lib/sync/protocol';
import type { SyncV2Client } from '@/lib/application/sync-v2-client';

/**
 * The only scope understood by the pre-account v1 adapters. Later vault-aware
 * adapters replace this value at the composition root; it never enters a card.
 */
export const LEGACY_NOTES_SCOPE = {
  kind: 'legacy',
  databaseName: 'fukamu-notes',
  syncEndpoint: '/api/sync',
} as const;

export type LegacyNotesScope = typeof LEGACY_NOTES_SCOPE;

/** Every runtime scope accepted by the notes application composition. */
export type NotesScope = LegacyNotesScope | VaultNotesScope;

export type NotesRepository<TScope extends NotesScope = NotesScope> = {
  readonly scope: TScope;
  loadCards: () => Promise<CardRecord[]>;
  loadConflicts: () => Promise<ConflictRecord[]>;
  loadOrCreateDeviceId: () => Promise<DeviceId>;
  loadPendingMutations: () => Promise<PendingMutation[]>;
  persistCardAndMutation: (
    card: CardRecord,
    options?: PendingMutationMode,
  ) => Promise<PendingMutation>;
  applySyncResponse: (
    input: unknown,
    sentMutations: PendingMutation[],
  ) => Promise<{ cards: CardRecord[]; conflicts: ConflictRecord[] }>;
};

export type SyncTransport<TScope extends NotesScope = NotesScope> = {
  readonly scope: TScope;
  send: (request: SyncRequestWire) => Promise<unknown>;
};

export type NotesSyncRuntime<TScope extends NotesScope = NotesScope> =
  | {
      readonly kind: 'v1';
      readonly transport: SyncTransport<TScope>;
    }
  | {
      readonly kind: 'v2';
      readonly client: SyncV2Client<TScope>;
    };

export type Clock = {
  now: () => number;
};

export type IdGenerator = {
  createCardId: () => CardId;
  createMutationId: () => MutationId;
  createDeviceId: () => DeviceId;
};

export type ConnectivityPort = {
  isOnline: () => boolean;
  subscribe: (listeners: {
    onOnline: () => void;
    onOffline: () => void;
  }) => () => void;
};

export type OfflineAppPort = {
  prepare: () => Promise<void>;
  purge: () => Promise<void>;
};

export type NotesRuntimePorts<TScope extends NotesScope = NotesScope> = {
  readonly scope: TScope;
  readonly repository: NotesRepository<TScope>;
  readonly sync: NotesSyncRuntime<TScope>;
  readonly clock: Clock;
  readonly idGenerator: IdGenerator;
  readonly connectivity: ConnectivityPort;
  readonly offlineApp: OfflineAppPort;
};

export type VaultNotesRuntimePorts = Omit<
  NotesRuntimePorts<VaultNotesScope>,
  'sync'
> & {
  readonly sync: Extract<
    NotesSyncRuntime<VaultNotesScope>,
    { readonly kind: 'v2' }
  >;
};
