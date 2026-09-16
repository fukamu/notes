import { describe, expect, it, vi } from 'vitest';
import { createFakePrivateObjectStorage } from '@/server/adapters/fake-private-object-storage';
import { createVaultPrivateObjectPurge } from '@/server/encrypted-object/delete-vault-objects';
import type {
  VaultObjectDeleteOutboxDirectory,
  VaultObjectDeleteOutboxRepository,
} from '@/server/encrypted-object/ports';
import { encryptedObjectIds } from '@/tests/fixtures/encrypted-object';
import { vaultContentContext } from '@/tests/fixtures/vault-content';

const entry = {
  objectKey: encryptedObjectIds.objectKeyA,
  attemptCount: 0,
  nextAttemptAt: 1_000,
  createdAt: 1_000,
} as const;

describe('Vault private object purge service', () => {
  it('rejects invalid worker policy without opening D1 or object storage', async () => {
    const open = vi.fn(async () => ({
      kind: 'owner-mismatch' as const,
    }));
    const objects = createFakePrivateObjectStorage();
    const purge = createVaultPrivateObjectPurge({
      scope: vaultContentContext('a'),
      outboxes: { open },
      objects,
      policy: { batchLimit: 0, retryDelayMs: 100 },
    });
    await expect(
      purge.purgeVaultPrivateObjects({
        scope: vaultContentContext('a'),
        attemptedAt: 1_000,
      }),
    ).resolves.toEqual({
      kind: 'terminal-failure',
      reason: 'invalid-command',
    });
    expect(open).not.toHaveBeenCalled();
    expect(objects.calls().delete).toBe(0);
  });

  it('fails closed when outbox inventory or selection is unavailable', async () => {
    const objects = createFakePrivateObjectStorage();
    const unavailableOpen: VaultObjectDeleteOutboxDirectory = {
      open: async () => {
        throw new Error('fixture open failure');
      },
    };
    await expect(
      purgeWith(unavailableOpen, objects).purgeVaultPrivateObjects(command()),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'outbox-unavailable',
    });

    const unavailableCount = repository({
      countPending: async () => {
        throw new Error('fixture count failure');
      },
    });
    await expect(
      purgeWith(opened(unavailableCount), objects).purgeVaultPrivateObjects(
        command(),
      ),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'outbox-unavailable',
    });

    const unavailableList = repository({
      countPending: async () => 1,
      listReady: async () => {
        throw new Error('fixture list failure');
      },
    });
    await expect(
      purgeWith(opened(unavailableList), objects).purgeVaultPrivateObjects(
        command(),
      ),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'outbox-unavailable',
    });
    expect(objects.calls().delete).toBe(0);
  });

  it('does not complete when the durable delete confirmation loses its CAS', async () => {
    const objects = createFakePrivateObjectStorage([
      {
        objectKey: entry.objectKey,
        bytes: new Uint8Array([1]),
        createdAt: entry.createdAt,
      },
    ]);
    const outbox = repository({
      countPending: async () => 1,
      listReady: async () => [entry],
      confirmDelete: async () => ({ kind: 'conflict' }),
    });
    await expect(
      purgeWith(opened(outbox), objects).purgeVaultPrivateObjects(command()),
    ).resolves.toEqual({
      kind: 'retryable-failure',
      reason: 'delete-confirmation-unavailable',
    });
    expect(objects.calls().delete).toBe(1);
  });
});

function command() {
  return {
    scope: vaultContentContext('a'),
    attemptedAt: 1_000,
  };
}

function purgeWith(
  outboxes: VaultObjectDeleteOutboxDirectory,
  objects: ReturnType<typeof createFakePrivateObjectStorage>,
) {
  return createVaultPrivateObjectPurge({
    scope: vaultContentContext('a'),
    outboxes,
    objects,
    policy: { batchLimit: 10, retryDelayMs: 100 },
  });
}

function opened(
  outbox: VaultObjectDeleteOutboxRepository,
): VaultObjectDeleteOutboxDirectory {
  return {
    open: async () => ({ kind: 'opened', repository: outbox }),
  };
}

function repository(
  overrides: Partial<VaultObjectDeleteOutboxRepository> = {},
): VaultObjectDeleteOutboxRepository {
  return {
    countPending: async () => 0,
    listReady: async () => [],
    confirmDelete: async () => ({ kind: 'applied' }),
    rescheduleDelete: async () => ({ kind: 'applied' }),
    ...overrides,
  };
}
