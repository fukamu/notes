import { vaultNotesScope } from '@/lib/application/notes-access';
import type { VaultNotesRuntimePorts } from '@/lib/application/notes-runtime';
import { createSyncV2Client } from '@/lib/application/sync-v2-client';
import { browserClock } from '@/lib/client/browser-clock';
import { browserConnectivity } from '@/lib/client/browser-connectivity';
import {
  createV2SyncTransport,
  type SyncFetch,
} from '@/lib/client/http-sync-transport';
import { browserIdGenerator } from '@/lib/client/id-generator';
import { browserOfflineApp } from '@/lib/client/offline';
import type { VaultContext } from '@/lib/domain/identity';
import {
  createIndexedDbNotesRepository,
  createIndexedDbSyncV2ReplicaRepository,
} from '@/lib/storage/indexed-db';

/** Binds authenticated Vault storage and transport without enabling production. */
export function createVaultNotesRuntimePorts(
  context: VaultContext,
  fetchRequest?: SyncFetch,
): VaultNotesRuntimePorts {
  const scope = vaultNotesScope(context);
  const repository = createIndexedDbNotesRepository(scope, browserIdGenerator);
  const replica = createIndexedDbSyncV2ReplicaRepository(scope);
  const transport = createV2SyncTransport(scope, fetchRequest);
  return {
    scope,
    repository,
    sync: {
      kind: 'v2',
      client: createSyncV2Client({ scope, transport, replica }),
    },
    clock: browserClock,
    idGenerator: browserIdGenerator,
    connectivity: browserConnectivity,
    offlineApp: browserOfflineApp,
  };
}
