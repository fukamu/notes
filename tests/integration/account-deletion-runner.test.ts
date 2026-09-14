import { describe, expect, it, vi } from 'vitest';
import {
  accountDeletionContinuationTokenDecoder,
  accountDeletionHandoffDecoder,
  accountDeletionIdempotencyKeyDecoder,
  sameAccountDeletionGeneration,
  type AccountDeletionHandoff,
  type AccountDeletionHandoffProgressPort,
  type AccountDeletionRemotePort,
} from '@/lib/application/account-deletion-handoff';
import { createAccountDeletionHandoffRunner } from '@/lib/application/account-deletion-runner';
import type { LogoutPurgeGeneration } from '@/lib/application/logout-purge';
import type { LogoutPurgeRunner } from '@/lib/application/logout-purge-runner';
import { decodeOrThrow } from '@/lib/codec/core';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const generation: LogoutPurgeGeneration = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};
const otherGeneration: LogoutPurgeGeneration = {
  ...generation,
  accountId: sessionFixtureIds.otherAccountId,
  vaultId: sessionFixtureIds.otherVaultId,
};
const idempotencyKey = decodeOrThrow(
  accountDeletionIdempotencyKeyDecoder,
  'I'.repeat(43),
  'fixture idempotency key',
);
const token0 = continuationToken(0);
const token1 = continuationToken(1);
const token2 = continuationToken(2);

describe('account deletion browser handoff runner', () => {
  it('persists a capability first, revokes the session, then delegates local erasure to logout purge', async () => {
    const calls: string[] = [];
    const progress = memoryProgressPort();
    const remote: AccountDeletionRemotePort = {
      async start(input) {
        calls.push(`start:${input.idempotencyKey}`);
        expect(progress.current()).toMatchObject({ kind: 'starting' });
        return {
          kind: 'accepted',
          status: { kind: 'in-progress', continuationToken: token0 },
        };
      },
      async resume(input) {
        calls.push(`resume:${input.continuationToken}`);
        expect(progress.current()).toMatchObject({ kind: 'revoke-pending' });
        return {
          kind: 'accepted',
          status: { kind: 'in-progress', continuationToken: token1 },
        };
      },
    };
    const logoutPurge: LogoutPurgeRunner = {
      async run(received) {
        calls.push(`purge:${received.vaultId}`);
        expect(progress.current()).toMatchObject({ kind: 'purge-pending' });
        return { kind: 'completed', completionAnnouncement: 'sent' };
      },
    };
    const runner = createRunner({ progress, remote, logoutPurge });

    await expect(runner.begin(generation)).resolves.toEqual({
      kind: 'pending',
      localContent: 'deleted',
      status: { kind: 'in-progress', continuationToken: token1 },
    });
    expect(calls).toEqual([
      `start:${idempotencyKey}`,
      `resume:${token0}`,
      `purge:${generation.vaultId}`,
    ]);
    expect(progress.current()).toMatchObject({
      kind: 'server-pending',
      revision: 4,
      server: { continuationToken: token1 },
    });
  });

  it('recovers a crash after the start response and reuses the durable idempotency key', async () => {
    const progress = memoryProgressPort();
    progress.failReplaceOnce();
    const start = vi.fn(async () => ({
      kind: 'accepted' as const,
      status: { kind: 'in-progress' as const, continuationToken: token0 },
    }));
    const resume = vi.fn(async () => ({
      kind: 'accepted' as const,
      status: { kind: 'completed' as const },
    }));
    const purge = vi.fn(async () => ({
      kind: 'completed' as const,
      completionAnnouncement: 'sent' as const,
    }));
    const runner = createRunner({
      progress,
      remote: { start, resume },
      logoutPurge: { run: purge },
    });

    await expect(runner.begin(generation)).resolves.toEqual({
      kind: 'failed',
      reason: 'concurrent-progress-change',
    });
    expect(progress.current()).toMatchObject({
      kind: 'starting',
      idempotencyKey,
    });

    await expect(runner.recover()).resolves.toEqual({
      kind: 'terminal',
      status: 'completed',
    });
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenNthCalledWith(1, { idempotencyKey });
    expect(start).toHaveBeenNthCalledWith(2, { idempotencyKey });
    expect(resume).toHaveBeenCalledWith({ continuationToken: token0 });
    expect(purge).toHaveBeenCalledWith(generation);
    expect(progress.current()).toBeUndefined();
  });

  it('keeps purge-pending durable when local deletion fails and retries no server effect', async () => {
    const progress = memoryProgressPort();
    const start = vi.fn(async () => ({
      kind: 'accepted' as const,
      status: { kind: 'in-progress' as const, continuationToken: token0 },
    }));
    const resume = vi.fn(async () => ({
      kind: 'accepted' as const,
      status: { kind: 'completed' as const },
    }));
    const purge = vi
      .fn<LogoutPurgeRunner['run']>()
      .mockResolvedValueOnce({
        kind: 'failed',
        target: 'vault-database',
        reason: 'adapter-failure',
      })
      .mockResolvedValueOnce({
        kind: 'completed',
        completionAnnouncement: 'sent',
      });
    const runner = createRunner({
      progress,
      remote: { start, resume },
      logoutPurge: { run: purge },
    });

    await expect(runner.begin(generation)).resolves.toEqual({
      kind: 'failed',
      reason: 'local-purge-failed',
    });
    expect(progress.current()).toMatchObject({ kind: 'purge-pending' });
    await expect(runner.recover()).resolves.toEqual({
      kind: 'terminal',
      status: 'completed',
    });
    expect(start).toHaveBeenCalledTimes(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(purge).toHaveBeenCalledTimes(2);
  });

  it('retains local content until a failed session-revocation step can retry', async () => {
    let now = 1_500;
    const progress = memoryProgressPort();
    const purge = vi.fn<LogoutPurgeRunner['run']>(async () => ({
      kind: 'completed',
      completionAnnouncement: 'sent',
    }));
    const resume = vi
      .fn<AccountDeletionRemotePort['resume']>()
      .mockResolvedValueOnce({
        kind: 'accepted',
        status: {
          kind: 'retry-wait',
          retryAt: 2_000,
          continuationToken: token1,
        },
      })
      .mockResolvedValueOnce({
        kind: 'accepted',
        status: { kind: 'in-progress', continuationToken: token2 },
      });
    const runner = createRunner({
      progress,
      remote: {
        start: async () => ({
          kind: 'accepted',
          status: { kind: 'in-progress', continuationToken: token0 },
        }),
        resume,
      },
      logoutPurge: { run: purge },
      clock: { now: () => now },
    });

    await expect(runner.begin(generation)).resolves.toEqual({
      kind: 'pending',
      localContent: 'retained',
      status: {
        kind: 'retry-wait',
        retryAt: 2_000,
        continuationToken: token1,
      },
    });
    expect(resume).toHaveBeenCalledTimes(1);
    await expect(runner.resumeServer()).resolves.toMatchObject({
      kind: 'pending',
      localContent: 'retained',
    });
    expect(resume).toHaveBeenCalledTimes(1);
    expect(purge).not.toHaveBeenCalled();

    now = 2_000;
    await expect(runner.resumeServer()).resolves.toEqual({
      kind: 'pending',
      localContent: 'deleted',
      status: { kind: 'in-progress', continuationToken: token2 },
    });
    expect(resume).toHaveBeenCalledTimes(2);
    expect(purge).toHaveBeenCalledExactlyOnceWith(generation);
  });

  it('honors retryAt and advances at most one post-purge server step per request', async () => {
    let now = 1_500;
    const progress = memoryProgressPort();
    const resume = vi
      .fn<AccountDeletionRemotePort['resume']>()
      .mockResolvedValueOnce({
        kind: 'accepted',
        status: { kind: 'in-progress', continuationToken: token1 },
      })
      .mockResolvedValueOnce({
        kind: 'accepted',
        status: {
          kind: 'retry-wait',
          retryAt: 2_000,
          continuationToken: token2,
        },
      })
      .mockResolvedValueOnce({
        kind: 'accepted',
        status: { kind: 'completed' },
      });
    const runner = createRunner({
      progress,
      remote: {
        start: async () => ({
          kind: 'accepted',
          status: { kind: 'in-progress', continuationToken: token0 },
        }),
        resume,
      },
      clock: { now: () => now },
    });

    await expect(runner.begin(generation)).resolves.toMatchObject({
      kind: 'pending',
      localContent: 'deleted',
      status: { continuationToken: token1 },
    });
    await expect(runner.resumeServer()).resolves.toEqual({
      kind: 'pending',
      localContent: 'deleted',
      status: {
        kind: 'retry-wait',
        retryAt: 2_000,
        continuationToken: token2,
      },
    });
    expect(resume).toHaveBeenCalledTimes(2);
    await expect(runner.resumeServer()).resolves.toMatchObject({
      kind: 'pending',
      localContent: 'deleted',
    });
    expect(resume).toHaveBeenCalledTimes(2);

    now = 2_000;
    await expect(runner.resumeServer()).resolves.toEqual({
      kind: 'terminal',
      status: 'completed',
    });
    expect(resume).toHaveBeenCalledTimes(3);
    expect(progress.current()).toBeUndefined();
  });

  it('fails closed for another generation and malformed durable state', async () => {
    const progress = memoryProgressPort();
    const start = vi.fn<AccountDeletionRemotePort['start']>(async () => ({
      kind: 'accepted',
      status: { kind: 'in-progress', continuationToken: token0 },
    }));
    const resume = vi.fn<AccountDeletionRemotePort['resume']>(async () => ({
      kind: 'accepted',
      status: { kind: 'in-progress', continuationToken: token1 },
    }));
    const remote: AccountDeletionRemotePort = {
      start,
      resume,
    };
    const runner = createRunner({ progress, remote });
    progress.set({ broken: true });
    await expect(runner.recover()).resolves.toEqual({
      kind: 'failed',
      reason: 'progress-recovery-required',
    });
    expect(start).not.toHaveBeenCalled();

    progress.set(undefined);
    await runner.begin(generation);
    await expect(runner.begin(otherGeneration)).resolves.toEqual({
      kind: 'failed',
      reason: 'another-deletion-pending',
    });
  });

  it('normalizes invalid random and clock adapter values without sending a request', async () => {
    const progress = memoryProgressPort();
    const start = vi.fn<AccountDeletionRemotePort['start']>();
    const resume = vi.fn<AccountDeletionRemotePort['resume']>();
    const remote: AccountDeletionRemotePort = {
      start,
      resume,
    };
    const invalidRandom = createAccountDeletionHandoffRunner({
      progress,
      remote,
      idempotencyKeys: {
        create() {
          throw new Error('random source failed');
        },
      },
      logoutPurge: completedPurge(),
      clock: { now: () => 1_500 },
    });
    await expect(invalidRandom.begin(generation)).resolves.toEqual({
      kind: 'failed',
      reason: 'progress-unavailable',
    });
    expect(start).not.toHaveBeenCalled();

    const retryProgress = memoryProgressPort();
    const retryRunner = createRunner({
      progress: retryProgress,
      remote: {
        start: async () => ({
          kind: 'accepted',
          status: {
            kind: 'retry-wait',
            retryAt: 2_000,
            continuationToken: token0,
          },
        }),
        resume,
      },
      clock: { now: () => 'invalid' },
    });
    await expect(retryRunner.begin(generation)).resolves.toEqual({
      kind: 'failed',
      reason: 'remote-unavailable',
    });
    expect(resume).not.toHaveBeenCalled();
    expect(retryProgress.current()).toMatchObject({ kind: 'revoke-pending' });
  });
});

function createRunner(input: {
  readonly progress: ReturnType<typeof memoryProgressPort>;
  readonly remote?: AccountDeletionRemotePort;
  readonly logoutPurge?: LogoutPurgeRunner;
  readonly clock?: { readonly now: () => unknown };
}) {
  return createAccountDeletionHandoffRunner({
    progress: input.progress,
    remote:
      input.remote ??
      ({
        start: async () => ({
          kind: 'accepted',
          status: { kind: 'in-progress', continuationToken: token0 },
        }),
        resume: async () => ({
          kind: 'accepted',
          status: { kind: 'in-progress', continuationToken: token1 },
        }),
      } satisfies AccountDeletionRemotePort),
    idempotencyKeys: { create: () => idempotencyKey },
    logoutPurge: input.logoutPurge ?? completedPurge(),
    clock: input.clock ?? { now: () => 1_500 },
  });
}

function completedPurge(): LogoutPurgeRunner {
  return {
    async run() {
      return { kind: 'completed', completionAnnouncement: 'sent' };
    },
  };
}

function memoryProgressPort() {
  let marker: unknown;
  let rejectNextReplace = false;
  const port: AccountDeletionHandoffProgressPort = {
    async read() {
      return marker;
    },
    async write(input) {
      if (input.kind === 'create') {
        if (marker !== undefined) return false;
        marker = input.handoff;
        return true;
      }
      if (rejectNextReplace) {
        rejectNextReplace = false;
        return false;
      }
      const decoded = decodeMarker(marker);
      if (
        decoded === undefined ||
        decoded.revision !== input.expectedRevision
      ) {
        return false;
      }
      marker = input.handoff;
      return true;
    },
    async clear(input) {
      const decoded = decodeMarker(marker);
      if (
        decoded === undefined ||
        decoded.revision !== input.expectedRevision ||
        !sameAccountDeletionGeneration(decoded, input.generation)
      ) {
        return false;
      }
      marker = undefined;
      return true;
    },
  };
  return {
    ...port,
    current: () => marker,
    set(value: unknown) {
      marker = value;
    },
    failReplaceOnce() {
      rejectNextReplace = true;
    },
  };
}

function decodeMarker(value: unknown): AccountDeletionHandoff | undefined {
  const decoded = accountDeletionHandoffDecoder.decode(value);
  return decoded.ok ? decoded.value : undefined;
}

function continuationToken(sequence: number) {
  return decodeOrThrow(
    accountDeletionContinuationTokenDecoder,
    `ad1.${'S'.repeat(43)}.${sequence}`,
    'fixture continuation token',
  );
}
