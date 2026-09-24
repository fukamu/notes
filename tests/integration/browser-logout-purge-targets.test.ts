import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VaultNotesScope } from '@/lib/application/notes-access';
import { createBrowserLogoutPurgeTargets } from '@/lib/client/browser-logout-purge';
import { browserIdGenerator } from '@/lib/client/id-generator';
import {
  hasOfflineLaunchAdmission,
  rememberOfflineLaunchAdmission,
} from '@/lib/client/production-launch-admission';
import {
  clearNotesDatabaseForTests,
  createIndexedDbNotesRepository,
  verifyNotesDatabaseDeleted,
} from '@/lib/storage/indexed-db';
import { createCompatibilityFixture } from '@/tests/fixtures/compatibility';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const generation = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};
const scope: VaultNotesScope = { kind: 'vault', ...generation };

afterEach(async () => {
  vi.unstubAllGlobals();
  const result = await verifyNotesDatabaseDeleted(scope);
  if (result.kind !== 'verified-deleted') {
    await clearNotesDatabaseForTests(scope);
  }
});

describe('browser logout purge target adapters', () => {
  it('closes, deletes, and verifies only the trusted Vault database', async () => {
    const repository = createIndexedDbNotesRepository(
      scope,
      browserIdGenerator,
    );
    const card = createCompatibilityFixture().cards[0];
    if (!card) throw new Error('missing compatibility card');
    await repository.persistCardAndMutation(card);
    vi.stubGlobal('caches', { keys: async () => [] });
    const admissionStorage = memoryStorage();
    vi.stubGlobal('sessionStorage', admissionStorage);
    rememberOfflineLaunchAdmission();
    const targets = createBrowserLogoutPurgeTargets(100);

    await expect(targets.closeLocalRuntime(generation)).resolves.toEqual({
      kind: 'completed',
    });
    await expect(targets.resetGraphWorker()).resolves.toEqual({
      kind: 'completed',
    });
    expect(hasOfflineLaunchAdmission()).toBe(false);
    await expect(targets.deleteVaultDatabase(generation)).resolves.toEqual({
      kind: 'completed',
    });
    await expect(targets.verifyDeletion(generation)).resolves.toEqual({
      kind: 'completed',
    });
  });

  it('fails final verification when CacheStorage is unavailable', async () => {
    const targets = createBrowserLogoutPurgeTargets(100);
    await targets.resetGraphWorker();
    await targets.deleteVaultDatabase(generation);
    vi.stubGlobal('caches', undefined);

    await expect(targets.verifyDeletion(generation)).resolves.toEqual({
      kind: 'failed',
      reason: 'unsupported-capability',
    });
  });
});

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}
