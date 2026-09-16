import { describe, expect, it } from 'vitest';
import {
  LOGOUT_PURGE_TARGETS,
  createLogoutPurgeProgress,
  transitionLogoutPurge,
  type LogoutPurgeGeneration,
  type LogoutPurgeProgress,
  type LogoutPurgeTarget,
} from '@/lib/application/logout-purge';
import {
  createLogoutPurgeRunner,
  type LogoutPurgeTargetPort,
} from '@/lib/application/logout-purge-runner';
import type {
  LogoutPurgeCoordinationPort,
  LogoutPurgeOwnerLease,
} from '@/lib/application/logout-runtime-coordination';
import { createFakeLogoutPurgeProgressPort } from '@/lib/client/fake-logout-purge-progress';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const generation: LogoutPurgeGeneration = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

function createCoordination() {
  const calls: string[] = [];
  const owner: LogoutPurgeOwnerLease = {
    async quiescePeers(attempt) {
      calls.push(`quiesce:${attempt}`);
      return {
        kind: 'quiesced',
        lease: {
          acknowledgedPeerIds: () => [],
          async release() {
            calls.push('release-peer');
          },
        },
      };
    },
    announceCompleted(attempt) {
      calls.push(`completed:${attempt}`);
      return 'sent';
    },
    async release() {
      calls.push('release-owner');
    },
  };
  const port: LogoutPurgeCoordinationPort = {
    async acquireOwner() {
      calls.push('acquire-owner');
      return { kind: 'acquired', lease: owner };
    },
  };
  return { calls, port };
}

function createTargets() {
  const calls: LogoutPurgeTarget[] = [];
  let failure:
    | {
        target: LogoutPurgeTarget;
        reason: 'blocked' | 'adapter-failure';
      }
    | undefined;
  const run = async (target: LogoutPurgeTarget) => {
    calls.push(target);
    if (failure?.target === target) {
      const current = failure;
      failure = undefined;
      return { kind: 'failed', reason: current.reason } as const;
    }
    return { kind: 'completed' } as const;
  };
  const port: LogoutPurgeTargetPort = {
    closeLocalRuntime: () => run('local-runtime'),
    resetGraphWorker: () => run('graph-worker'),
    purgeServiceWorkerCache: () => run('service-worker-cache'),
    deleteVaultDatabase: () => run('vault-database'),
    verifyDeletion: () => run('deletion-verification'),
  };
  return {
    calls,
    port,
    failNext(target: LogoutPurgeTarget, reason: 'blocked' | 'adapter-failure') {
      failure = { target, reason };
    },
  };
}

describe('logout purge runner', () => {
  it('persists the ordered browser effects and clears only after verification', async () => {
    const progress = createFakeLogoutPurgeProgressPort();
    const coordination = createCoordination();
    const targets = createTargets();
    const runner = createLogoutPurgeRunner({
      progress,
      coordination: coordination.port,
      targets: targets.port,
    });

    await expect(runner.run(generation)).resolves.toEqual({
      kind: 'completed',
      completionAnnouncement: 'sent',
    });
    expect(targets.calls).toEqual([
      'local-runtime',
      'graph-worker',
      'service-worker-cache',
      'vault-database',
      'deletion-verification',
    ]);
    expect(coordination.calls[0]).toBe('acquire-owner');
    expect(coordination.calls.some((call) => call.startsWith('quiesce:'))).toBe(
      true,
    );
    expect(coordination.calls.slice(-2)).toEqual([
      'release-peer',
      'release-owner',
    ]);
    expect(progress.marker()).toBeUndefined();
  });

  it('persists a blocked database delete and retries only from that target', async () => {
    const progress = createFakeLogoutPurgeProgressPort();
    const coordination = createCoordination();
    const targets = createTargets();
    targets.failNext('vault-database', 'blocked');
    const runner = createLogoutPurgeRunner({
      progress,
      coordination: coordination.port,
      targets: targets.port,
    });

    await expect(runner.run(generation)).resolves.toEqual({
      kind: 'failed',
      target: 'vault-database',
      reason: 'blocked',
    });
    expect(progress.marker()).toMatchObject({
      kind: 'failed',
      target: 'vault-database',
      reason: 'blocked',
    });

    targets.calls.length = 0;
    await expect(runner.run(generation)).resolves.toMatchObject({
      kind: 'completed',
    });
    expect(targets.calls).toEqual(['vault-database', 'deletion-verification']);
  });

  it.each(LOGOUT_PURGE_TARGETS)(
    'recovers an interrupted %s phase and completes idempotently',
    async (target) => {
      const progress = createFakeLogoutPurgeProgressPort(
        runningProgressAt(target),
      );
      const coordination = createCoordination();
      const targets = createTargets();
      const runner = createLogoutPurgeRunner({
        progress,
        coordination: coordination.port,
        targets: targets.port,
      });

      await expect(runner.run(generation)).resolves.toMatchObject({
        kind: 'completed',
      });
      expect(progress.marker()).toBeUndefined();
    },
  );
});

function runningProgressAt(target: LogoutPurgeTarget): LogoutPurgeProgress {
  let progress = createLogoutPurgeProgress(generation);
  for (const current of LOGOUT_PURGE_TARGETS) {
    const started = transitionLogoutPurge(progress, {
      type: 'target-started',
      generation,
      target: current,
    });
    if (started.kind !== 'advanced') {
      throw new Error('fixture target did not start');
    }
    progress = started.progress;
    if (current === target) return progress;
    const completed = transitionLogoutPurge(progress, {
      type: 'target-completed',
      generation,
      target: current,
    });
    if (completed.kind !== 'advanced') {
      throw new Error('fixture target did not advance');
    }
    progress = completed.progress;
  }
  throw new Error('fixture target is missing');
}
