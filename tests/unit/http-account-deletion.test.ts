import { describe, expect, it, vi } from 'vitest';
import {
  accountDeletionContinuationTokenDecoder,
  accountDeletionIdempotencyKeyDecoder,
} from '@/lib/application/account-deletion-handoff';
import { createBrowserIdempotencyKeyGenerator } from '@/lib/client/browser-account-deletion';
import { createAccountDeletionHttpRemote } from '@/lib/client/http-account-deletion';
import { decodeOrThrow } from '@/lib/codec/core';

const key = decodeOrThrow(
  accountDeletionIdempotencyKeyDecoder,
  'I'.repeat(43),
  'fixture idempotency key',
);
const token = decodeOrThrow(
  accountDeletionContinuationTokenDecoder,
  `ad1.${'S'.repeat(43)}.0`,
  'fixture continuation token',
);

describe('account deletion browser HTTP adapter', () => {
  it('sends only the capability fields with same-origin no-store semantics', async () => {
    const fetchRequest = vi.fn(async () =>
      Response.json({
        status: 'in-progress',
        continuationToken: token,
      }),
    );
    const remote = createAccountDeletionHttpRemote(fetchRequest);

    await expect(remote.start({ idempotencyKey: key })).resolves.toEqual({
      kind: 'accepted',
      status: { kind: 'in-progress', continuationToken: token },
    });
    expect(fetchRequest).toHaveBeenCalledWith('/api/account/deletion', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idempotencyKey: key }),
    });
  });

  it('uses the session-independent status endpoint after revocation', async () => {
    const fetchRequest = vi.fn(async () =>
      Response.json({ status: 'completed' }),
    );
    await expect(
      createAccountDeletionHttpRemote(fetchRequest).resume({
        continuationToken: token,
      }),
    ).resolves.toEqual({
      kind: 'accepted',
      status: { kind: 'completed' },
    });
    expect(fetchRequest).toHaveBeenCalledWith(
      '/api/account/deletion/status',
      expect.objectContaining({
        body: JSON.stringify({ continuationToken: token }),
      }),
    );
  });

  it.each([
    [401, 'authorization-required'],
    [409, 'request-conflict'],
    [500, 'remote-unavailable'],
  ] as const)(
    'maps HTTP %s to %s without trusting an error body',
    async (status, reason) => {
      const remote = createAccountDeletionHttpRemote(async () =>
        Response.json({ accountId: 'must-not-be-read' }, { status }),
      );
      await expect(remote.start({ idempotencyKey: key })).resolves.toEqual({
        kind: 'rejected',
        reason,
      });
    },
  );

  it('rejects malformed success JSON and transport failures', async () => {
    await expect(
      createAccountDeletionHttpRemote(async () =>
        Response.json({ status: 'completed', continuationToken: token }),
      ).resume({ continuationToken: token }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'remote-unavailable' });
    await expect(
      createAccountDeletionHttpRemote(async () => {
        throw new Error('offline');
      }).start({ idempotencyKey: key }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'remote-unavailable' });
  });

  it('generates an unpadded 256-bit base64url idempotency key', () => {
    const generator = createBrowserIdempotencyKeyGenerator((bytes) => {
      bytes.fill(0);
    });
    const generated = generator.create();
    expect(generated).toBe('A'.repeat(43));
    expect(accountDeletionIdempotencyKeyDecoder.decode(generated).ok).toBe(
      true,
    );
  });
});
