import {
  LEGACY_NOTES_SCOPE,
  type LegacyNotesScope,
  type NotesRuntimePorts,
} from '@/lib/application/notes-runtime';
import { browserClock } from '@/lib/client/browser-clock';
import { browserConnectivity } from '@/lib/client/browser-connectivity';
import { createV1SyncTransport } from '@/lib/client/http-sync-transport';
import { browserIdGenerator } from '@/lib/client/id-generator';
import { browserOfflineApp } from '@/lib/client/offline';
import { createIndexedDbNotesRepository } from '@/lib/storage/indexed-db';

/** Binds the unchanged v1 browser adapters to their explicit legacy scope. */
export function createLegacyNotesRuntimePorts(): NotesRuntimePorts<LegacyNotesScope> {
  return {
    scope: LEGACY_NOTES_SCOPE,
    repository: createIndexedDbNotesRepository(
      LEGACY_NOTES_SCOPE,
      browserIdGenerator,
    ),
    syncTransport: createV1SyncTransport(LEGACY_NOTES_SCOPE),
    clock: browserClock,
    idGenerator: browserIdGenerator,
    connectivity: browserConnectivity,
    offlineApp: browserOfflineApp,
  };
}
