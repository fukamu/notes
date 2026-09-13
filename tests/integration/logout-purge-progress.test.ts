import { describe, expect, it } from 'vitest';
import {
  LOGOUT_PURGE_TARGETS,
  createLogoutPurgeProgress,
  type LogoutPurgeEvent,
  type LogoutPurgeGeneration,
  type LogoutPurgeProgress,
  type LogoutPurgeTarget,
} from '@/lib/application/logout-purge';
import {
  applyLogoutPurgeEvent,
  readLogoutPurgeProgress,
  startOrResumeLogoutPurge,
} from '@/lib/application/logout-purge-progress';
import { createFakeLogoutPurgeProgressPort } from '@/lib/client/fake-logout-purge-progress';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const generation: LogoutPurgeGeneration = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

function event(
  type: LogoutPurgeEvent['type'],
  target: LogoutPurgeTarget,
): LogoutPurgeEvent {
  return type === 'target-failed'
    ? { type, generation, target, reason: 'adapter-failure' }
    : { type, generation, target };
}

function progressFrom(
  result: Awaited<ReturnType<typeof applyLogoutPurgeEvent>>,
): LogoutPurgeProgress {
  if (result.kind !== 'advanced') {
    throw new Error(`expected advanced progress, received ${result.kind}`);
  }
  return result.progress;
}

describe('logout purge progress coordinator', () => {
  it('creates once, resumes the same generation, and blocks another account', async () => {
    const port = createFakeLogoutPurgeProgressPort();
    const started = await startOrResumeLogoutPurge(generation, port);

    expect(started).toEqual({
      kind: 'started',
      progress: createLogoutPurgeProgress(generation),
    });
    expect(port.marker()).toEqual(createLogoutPurgeProgress(generation));
    await expect(startOrResumeLogoutPurge(generation, port)).resolves.toEqual({
      kind: 'resumed',
      progress: createLogoutPurgeProgress(generation),
    });
    await expect(
      startOrResumeLogoutPurge(
        { ...generation, accountId: sessionFixtureIds.otherAccountId },
        port,
      ),
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'another-purge-pending',
    });
  });

  it('persists an interrupted failure when a running target is resumed after crash', async () => {
    const port = createFakeLogoutPurgeProgressPort();
    const started = await startOrResumeLogoutPurge(generation, port);
    if (started.kind !== 'started') throw new Error('purge did not start');
    const running = progressFrom(
      await applyLogoutPurgeEvent(
        started.progress,
        event('target-started', started.progress.target),
        port,
      ),
    );

    const recovered = await startOrResumeLogoutPurge(generation, port);

    expect(recovered).toEqual({
      kind: 'recovered',
      progress: {
        ...running,
        kind: 'failed',
        revision: running.revision + 1,
        reason: 'interrupted',
      },
    });
    expect(port.marker()).toEqual(
      recovered.kind === 'recovered' ? recovered.progress : undefined,
    );
  });

  it('retains the final running marker until verified clear succeeds', async () => {
    const port = createFakeLogoutPurgeProgressPort();
    const started = await startOrResumeLogoutPurge(generation, port);
    if (started.kind !== 'started') throw new Error('purge did not start');
    let progress = started.progress;

    for (const target of LOGOUT_PURGE_TARGETS) {
      const running = await applyLogoutPurgeEvent(
        progress,
        event('target-started', target),
        port,
      );
      progress = progressFrom(running);
      if (target === 'deletion-verification') break;
      progress = progressFrom(
        await applyLogoutPurgeEvent(
          progress,
          event('target-completed', target),
          port,
        ),
      );
    }

    expect(progress).toMatchObject({
      kind: 'running',
      target: 'deletion-verification',
    });
    port.failNext('clear', 'invalid-result');
    await expect(
      applyLogoutPurgeEvent(
        progress,
        event('target-completed', progress.target),
        port,
      ),
    ).resolves.toEqual({
      kind: 'failed',
      reason: 'progress-unavailable',
    });
    expect(port.marker()).toEqual(progress);

    await expect(
      applyLogoutPurgeEvent(
        progress,
        event('target-completed', progress.target),
        port,
      ),
    ).resolves.toEqual({ kind: 'completed' });
    expect(port.marker()).toBeUndefined();
  });

  it('does not overwrite a concurrently advanced marker from stale progress', async () => {
    const port = createFakeLogoutPurgeProgressPort();
    const stale = createLogoutPurgeProgress(generation);
    port.seed(stale);
    const current = progressFrom(
      await applyLogoutPurgeEvent(
        stale,
        event('target-started', stale.target),
        port,
      ),
    );

    await expect(
      applyLogoutPurgeEvent(stale, event('target-started', stale.target), port),
    ).resolves.toEqual({
      kind: 'failed',
      reason: 'concurrent-progress-change',
    });
    expect(port.marker()).toEqual(current);
  });

  it.each(['throw', 'invalid-result'] as const)(
    'keeps progress unchanged when a write returns %s',
    async (failure) => {
      const pending = createLogoutPurgeProgress(generation);
      const port = createFakeLogoutPurgeProgressPort(pending);
      port.failNext('write', failure);

      await expect(
        applyLogoutPurgeEvent(
          pending,
          event('target-started', pending.target),
          port,
        ),
      ).resolves.toEqual({
        kind: 'failed',
        reason: 'progress-unavailable',
      });
      expect(port.marker()).toEqual(pending);
    },
  );

  it('fails closed for unavailable, corrupt, or unknown-version progress', async () => {
    const unavailable = createFakeLogoutPurgeProgressPort();
    unavailable.failNext('read', 'throw');
    await expect(readLogoutPurgeProgress(unavailable)).resolves.toEqual({
      kind: 'unavailable',
    });

    const corrupt = createFakeLogoutPurgeProgressPort({ invalid: true });
    await expect(
      startOrResumeLogoutPurge(generation, corrupt),
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'progress-recovery-required',
    });

    const unknownVersion = createFakeLogoutPurgeProgressPort({
      schemaVersion: 'logout-purge/v2',
    });
    await expect(
      startOrResumeLogoutPurge(generation, unknownVersion),
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'progress-recovery-required',
    });
  });

  it('does not report a failed initial marker write as logout started', async () => {
    const port = createFakeLogoutPurgeProgressPort();
    port.failNext('write', 'throw');

    await expect(startOrResumeLogoutPurge(generation, port)).resolves.toEqual({
      kind: 'blocked',
      reason: 'progress-unavailable',
    });
    expect(port.marker()).toBeUndefined();
  });
});
