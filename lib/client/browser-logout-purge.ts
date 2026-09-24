'use client';

import { createLogoutPurgeRunner } from '@/lib/application/logout-purge-runner';
import type { LogoutPurgeTargetPort } from '@/lib/application/logout-purge-runner';
import {
  createLogoutPurgeCoordination,
  createLogoutRuntimeFence,
  type LogoutRuntimeFencePort,
} from '@/lib/application/logout-runtime-coordination';
import type { LogoutPurgeGeneration } from '@/lib/application/logout-purge';
import type { LogoutPurgeRunner } from '@/lib/application/logout-purge-runner';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import {
  createBrowserLogoutCoordinationPlatform,
  createBrowserTabInstanceId,
} from '@/lib/client/browser-logout-coordination';
import { createBrowserLogoutPurgeProgressPort } from '@/lib/client/browser-logout-purge-progress';
import {
  browserServiceWorkerLogoutCachePlatform,
  createServiceWorkerLogoutCachePurge,
  verifyBrowserServiceWorkerCaches,
} from '@/lib/client/browser-service-worker-purge';
import {
  connectionsLayoutWorkerIsReset,
  resetConnectionsLayoutWorker,
} from '@/lib/client/connections-layout-worker';
import { clearOfflineLaunchAdmission } from '@/lib/client/production-launch-admission';
import { assertNever } from '@/lib/shared/invariant';
import {
  closeNotesDatabase,
  deleteNotesDatabase,
  notesDatabaseConnectionIsClosed,
  verifyNotesDatabaseDeleted,
} from '@/lib/storage/indexed-db';

const DEFAULT_LOCK_TIMEOUT_MS = 8_000;
const DEFAULT_SERVICE_WORKER_TIMEOUT_MS = 8_000;

export type BrowserLogoutPurgeService = {
  readonly runtimeFence: LogoutRuntimeFencePort;
  readonly purge: LogoutPurgeRunner;
};

/** Browser composition for authenticated routes; LegacyNotesApp does not use it. */
export function createBrowserLogoutPurgeService(options?: {
  readonly lockTimeoutMs?: number;
  readonly serviceWorkerTimeoutMs?: number;
}): BrowserLogoutPurgeService {
  const progress = createBrowserLogoutPurgeProgressPort();
  const platform = createBrowserLogoutCoordinationPlatform();
  const tabId = createBrowserTabInstanceId();
  const lockTimeoutMs = options?.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS;
  const coordination = createLogoutPurgeCoordination({
    platform,
    tabId,
    lockTimeoutMs,
  });
  const targets = createBrowserLogoutPurgeTargets(
    options?.serviceWorkerTimeoutMs ?? DEFAULT_SERVICE_WORKER_TIMEOUT_MS,
  );
  return {
    runtimeFence: createLogoutRuntimeFence({
      progressPort: progress,
      platform,
      tabId,
      lockTimeoutMs,
    }),
    purge: createLogoutPurgeRunner({ progress, coordination, targets }),
  };
}

export function createBrowserLogoutPurgeTargets(
  serviceWorkerTimeoutMs: number,
): LogoutPurgeTargetPort {
  const purgeServiceWorkerCache = createServiceWorkerLogoutCachePurge(
    browserServiceWorkerLogoutCachePlatform,
    serviceWorkerTimeoutMs,
  );
  return {
    async closeLocalRuntime(generation) {
      const result = await closeNotesDatabase(vaultScope(generation));
      switch (result.kind) {
        case 'closed':
        case 'not-open':
          return { kind: 'completed' };
        default:
          return assertNever(result, 'Unsupported database close result');
      }
    },
    async resetGraphWorker() {
      clearOfflineLaunchAdmission();
      resetConnectionsLayoutWorker();
      return connectionsLayoutWorkerIsReset()
        ? { kind: 'completed' }
        : { kind: 'failed', reason: 'verification-failed' };
    },
    purgeServiceWorkerCache,
    async deleteVaultDatabase(generation) {
      const result = await deleteNotesDatabase(vaultScope(generation));
      switch (result.kind) {
        case 'deleted':
          return { kind: 'completed' };
        case 'blocked':
          return { kind: 'failed', reason: 'blocked' };
        case 'failed':
          return { kind: 'failed', reason: 'adapter-failure' };
        default:
          return assertNever(result, 'Unsupported database deletion result');
      }
    },
    async verifyDeletion(generation) {
      const scope = vaultScope(generation);
      if (!notesDatabaseConnectionIsClosed(scope)) {
        return { kind: 'failed', reason: 'verification-failed' };
      }
      if (!connectionsLayoutWorkerIsReset()) {
        return { kind: 'failed', reason: 'verification-failed' };
      }
      const cacheResult = await verifyBrowserServiceWorkerCaches();
      if (cacheResult.kind === 'failed') return cacheResult;
      const databaseResult = await verifyNotesDatabaseDeleted(scope);
      switch (databaseResult.kind) {
        case 'verified-deleted':
          return { kind: 'completed' };
        case 'still-present':
          return { kind: 'failed', reason: 'verification-failed' };
        case 'unsupported-capability':
          return { kind: 'failed', reason: 'unsupported-capability' };
        case 'failed':
          return { kind: 'failed', reason: 'adapter-failure' };
        default:
          return assertNever(
            databaseResult,
            'Unsupported database verification result',
          );
      }
    },
  };
}

function vaultScope(generation: LogoutPurgeGeneration): VaultNotesScope {
  return { kind: 'vault', ...generation };
}
