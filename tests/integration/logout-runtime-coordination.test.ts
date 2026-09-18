import { describe, expect, it, vi } from 'vitest';
import {
  createLogoutPurgeRequest,
  logoutCoordinationChannelName,
  logoutRuntimeLockName,
  parseTabInstanceId,
} from '@/lib/application/logout-coordination';
import {
  createLogoutPurgeProgress,
  type LogoutPurgeGeneration,
} from '@/lib/application/logout-purge';
import { startOrResumeLogoutPurge } from '@/lib/application/logout-purge-progress';
import {
  createLogoutPurgeCoordination,
  createLogoutRuntimeFence,
  type LogoutRuntimeFenceLease,
} from '@/lib/application/logout-runtime-coordination';
import { createFakeLogoutPurgeProgressPort } from '@/lib/client/fake-logout-purge-progress';
import { sessionFixtureIds } from '@/tests/fixtures/session';
import { InMemoryLogoutCoordinationPlatform } from '@/tests/fakes/logout-coordination-platform';

const generation: LogoutPurgeGeneration = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};
const firstTabId = parseTabInstanceId('00000000-0000-4000-8000-000000000011');
const secondTabId = parseTabInstanceId('00000000-0000-4000-8000-000000000012');
const ownerTabId = parseTabInstanceId('00000000-0000-4000-8000-000000000013');
const nextOwnerTabId = parseTabInstanceId(
  '00000000-0000-4000-8000-000000000014',
);

describe('logout runtime fence and multi-tab coordination', () => {
  it('quiesces two runtimes, proves their shared locks drained, and elects one owner', async () => {
    const progress = createFakeLogoutPurgeProgressPort();
    const platform = new InMemoryLogoutCoordinationPlatform();
    const firstStopped = vi.fn();
    const secondStopped = vi.fn();
    const firstLease: { current?: LogoutRuntimeFenceLease } = {};
    const secondLease: { current?: LogoutRuntimeFenceLease } = {};
    const first = await createLogoutRuntimeFence({
      progressPort: progress,
      platform,
      tabId: firstTabId,
      lockTimeoutMs: 100,
    }).enter({
      generation,
      onPurgeRequested: () => {
        firstStopped();
        if (firstLease.current) void firstLease.current.quiesce();
      },
    });
    const second = await createLogoutRuntimeFence({
      progressPort: progress,
      platform,
      tabId: secondTabId,
      lockTimeoutMs: 100,
    }).enter({
      generation,
      onPurgeRequested: () => {
        secondStopped();
        if (secondLease.current) void secondLease.current.quiesce();
      },
    });
    if (first.kind !== 'entered' || second.kind !== 'entered') {
      throw new Error('expected both runtime fences to enter');
    }
    firstLease.current = first.lease;
    secondLease.current = second.lease;
    await startOrResumeLogoutPurge(generation, progress);

    const ownerCoordinator = createLogoutPurgeCoordination({
      platform,
      tabId: firstTabId,
      lockTimeoutMs: 100,
    });
    const owner = await ownerCoordinator.acquireOwner(generation);
    if (owner.kind !== 'acquired') throw new Error('expected purge owner');
    const contender = await createLogoutPurgeCoordination({
      platform,
      tabId: nextOwnerTabId,
      lockTimeoutMs: 100,
    }).acquireOwner(generation);
    expect(contender).toEqual({ kind: 'failed', reason: 'contended' });

    const quiesced = await owner.lease.quiescePeers(1);
    if (quiesced.kind !== 'quiesced') {
      throw new Error(`expected peers to quiesce: ${quiesced.reason}`);
    }
    await Promise.resolve();
    expect(firstStopped).toHaveBeenCalledOnce();
    expect(secondStopped).toHaveBeenCalledOnce();
    // The owner tab's runtime also stops, but its acknowledgement is not
    // counted as a peer. The exclusive runtime lock proves both released.
    expect(quiesced.lease.acknowledgedPeerIds()).toEqual([secondTabId]);
    // Simulate an owner crash before completion. Quiesced peers retain only
    // their channel subscription so a new attempt can be acknowledged.
    await quiesced.lease.release();
    await owner.lease.release();

    const reElected = await createLogoutPurgeCoordination({
      platform,
      tabId: nextOwnerTabId,
      lockTimeoutMs: 100,
    }).acquireOwner(generation);
    expect(reElected.kind).toBe('acquired');
    if (reElected.kind === 'acquired') {
      const retried = await reElected.lease.quiescePeers(2);
      if (retried.kind !== 'quiesced') {
        throw new Error('expected crash retry to quiesce');
      }
      await Promise.resolve();
      expect(retried.lease.acknowledgedPeerIds()).toEqual([
        firstTabId,
        secondTabId,
      ]);
      expect(reElected.lease.announceCompleted(2)).toBe('sent');
      await Promise.resolve();
      await retried.lease.release();
      await reElected.lease.release();
    }
    await firstLease.current.close();
    await secondLease.current.close();
  });

  it('subscribes before a delayed shared lock so an in-between purge cannot be lost', async () => {
    const progress = createFakeLogoutPurgeProgressPort();
    const platform = new InMemoryLogoutCoordinationPlatform();
    const foreignExclusive = await platform.acquireLock({
      name: logoutRuntimeLockName(generation),
      mode: 'exclusive',
      ifAvailable: false,
      timeoutMs: 100,
    });
    if (foreignExclusive.kind !== 'acquired') {
      throw new Error('expected foreign exclusive lock');
    }
    const stop = vi.fn();
    const entering = createLogoutRuntimeFence({
      progressPort: progress,
      platform,
      tabId: firstTabId,
      lockTimeoutMs: 100,
    }).enter({ generation, onPurgeRequested: stop });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await startOrResumeLogoutPurge(generation, progress);
    const owner = await createLogoutPurgeCoordination({
      platform,
      tabId: ownerTabId,
      lockTimeoutMs: 100,
    }).acquireOwner(generation);
    if (owner.kind !== 'acquired') throw new Error('expected owner');
    const quiescing = owner.lease.quiescePeers(1);
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();

    await foreignExclusive.lease.release();
    await expect(entering).resolves.toEqual({
      kind: 'blocked',
      reason: 'purge-pending',
    });
    const quiesced = await quiescing;
    expect(quiesced.kind).toBe('quiesced');
    await owner.lease.release();
  });

  it('blocks an observed purge request even if a faulty sender omitted the marker', async () => {
    const progress = createFakeLogoutPurgeProgressPort();
    const platform = new InMemoryLogoutCoordinationPlatform();
    const foreignExclusive = await platform.acquireLock({
      name: logoutRuntimeLockName(generation),
      mode: 'exclusive',
      ifAvailable: false,
      timeoutMs: 100,
    });
    if (foreignExclusive.kind !== 'acquired') {
      throw new Error('expected foreign exclusive lock');
    }
    const stop = vi.fn();
    const entering = createLogoutRuntimeFence({
      progressPort: progress,
      platform,
      tabId: firstTabId,
      lockTimeoutMs: 100,
    }).enter({ generation, onPurgeRequested: stop });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const sender = platform.openChannel(
      logoutCoordinationChannelName(generation),
    );
    if (sender.kind !== 'opened') throw new Error('expected sender channel');
    sender.channel.post(createLogoutPurgeRequest(generation, 1, ownerTabId));
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
    await foreignExclusive.lease.release();
    await expect(entering).resolves.toEqual({
      kind: 'blocked',
      reason: 'purge-requested',
    });
    sender.channel.close();
  });

  it('closes the marker-read/shared-lock race before runtime construction', async () => {
    const marker = createLogoutPurgeProgress(generation);
    let reads = 0;
    const platform = new InMemoryLogoutCoordinationPlatform();
    const result = await createLogoutRuntimeFence({
      progressPort: {
        read: async () => (++reads === 1 ? undefined : marker),
        write: async () => false,
        clear: async () => false,
      },
      platform,
      tabId: firstTabId,
      lockTimeoutMs: 100,
    }).enter({ generation, onPurgeRequested: vi.fn() });
    expect(result).toEqual({ kind: 'blocked', reason: 'purge-pending' });
    expect(reads).toBe(2);

    const exclusive = await platform.acquireLock({
      name: logoutRuntimeLockName(generation),
      mode: 'exclusive',
      ifAvailable: true,
      timeoutMs: 100,
    });
    expect(exclusive.kind).toBe('acquired');
    if (exclusive.kind === 'acquired') await exclusive.lease.release();
  });

  it('fails closed for pending, corrupt, unavailable, and unsupported state', async () => {
    const cases = [
      [createLogoutPurgeProgress(generation), 'purge-pending'],
      [
        createLogoutPurgeProgress({
          ...generation,
          accountId: sessionFixtureIds.otherAccountId,
          vaultId: sessionFixtureIds.otherVaultId,
        }),
        'purge-pending',
      ],
      [{ invalid: true }, 'progress-recovery-required'],
    ] as const;
    for (const [marker, reason] of cases) {
      const result = await createLogoutRuntimeFence({
        progressPort: createFakeLogoutPurgeProgressPort(marker),
        platform: new InMemoryLogoutCoordinationPlatform(),
        tabId: firstTabId,
        lockTimeoutMs: 100,
      }).enter({ generation, onPurgeRequested: vi.fn() });
      expect(result).toEqual({ kind: 'blocked', reason });
    }

    const unavailable = createFakeLogoutPurgeProgressPort();
    unavailable.failNext('read', 'throw');
    expect(
      await createLogoutRuntimeFence({
        progressPort: unavailable,
        platform: new InMemoryLogoutCoordinationPlatform(),
        tabId: firstTabId,
        lockTimeoutMs: 100,
      }).enter({ generation, onPurgeRequested: vi.fn() }),
    ).toEqual({ kind: 'blocked', reason: 'progress-unavailable' });

    const noChannel = new InMemoryLogoutCoordinationPlatform();
    noChannel.setChannelSupported(false);
    expect(
      await createLogoutRuntimeFence({
        progressPort: createFakeLogoutPurgeProgressPort(),
        platform: noChannel,
        tabId: firstTabId,
        lockTimeoutMs: 100,
      }).enter({ generation, onPurgeRequested: vi.fn() }),
    ).toEqual({ kind: 'blocked', reason: 'unsupported-capability' });

    const noLocks = new InMemoryLogoutCoordinationPlatform();
    noLocks.setLockSupported(false);
    expect(
      await createLogoutRuntimeFence({
        progressPort: createFakeLogoutPurgeProgressPort(),
        platform: noLocks,
        tabId: firstTabId,
        lockTimeoutMs: 100,
      }).enter({ generation, onPurgeRequested: vi.fn() }),
    ).toEqual({ kind: 'blocked', reason: 'unsupported-capability' });
  });

  it('reports channel, lock, post, timeout, and repeated coordination failures', async () => {
    const progress = createFakeLogoutPurgeProgressPort();
    const channelFailure = new InMemoryLogoutCoordinationPlatform();
    channelFailure.failNextChannelOpen();
    expect(
      await createLogoutPurgeCoordination({
        platform: channelFailure,
        tabId: ownerTabId,
        lockTimeoutMs: 100,
      }).acquireOwner(generation),
    ).toEqual({ kind: 'failed', reason: 'adapter-failure' });

    const lockFailure = new InMemoryLogoutCoordinationPlatform();
    lockFailure.failNextLock();
    expect(
      await createLogoutPurgeCoordination({
        platform: lockFailure,
        tabId: ownerTabId,
        lockTimeoutMs: 100,
      }).acquireOwner(generation),
    ).toEqual({ kind: 'failed', reason: 'adapter-failure' });

    const postFailure = new InMemoryLogoutCoordinationPlatform();
    const postOwner = await createLogoutPurgeCoordination({
      platform: postFailure,
      tabId: ownerTabId,
      lockTimeoutMs: 100,
    }).acquireOwner(generation);
    if (postOwner.kind !== 'acquired') throw new Error('expected owner');
    expect(await postOwner.lease.quiescePeers(0)).toEqual({
      kind: 'failed',
      reason: 'invalid-attempt',
    });
    postFailure.failNextPost();
    expect(await postOwner.lease.quiescePeers(1)).toEqual({
      kind: 'failed',
      reason: 'adapter-failure',
    });
    expect(await postOwner.lease.quiescePeers(1)).toMatchObject({
      kind: 'quiesced',
    });
    expect(await postOwner.lease.quiescePeers(1)).toEqual({
      kind: 'failed',
      reason: 'already-coordinating',
    });
    await postOwner.lease.release();

    const timeoutPlatform = new InMemoryLogoutCoordinationPlatform();
    const foreignRuntime = await timeoutPlatform.acquireLock({
      name: logoutRuntimeLockName(generation),
      mode: 'shared',
      ifAvailable: false,
      timeoutMs: 100,
    });
    if (foreignRuntime.kind !== 'acquired') throw new Error('expected holder');
    const timeoutOwner = await createLogoutPurgeCoordination({
      platform: timeoutPlatform,
      tabId: ownerTabId,
      lockTimeoutMs: 5,
    }).acquireOwner(generation);
    if (timeoutOwner.kind !== 'acquired') throw new Error('expected owner');
    expect(await timeoutOwner.lease.quiescePeers(1)).toEqual({
      kind: 'failed',
      reason: 'timeout',
    });
    await foreignRuntime.lease.release();
    await timeoutOwner.lease.release();
    expect(progress.marker()).toBeUndefined();
  });
});
