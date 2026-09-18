import { describe, expect, it } from 'vitest';
import {
  LOGOUT_PURGE_SCHEMA_VERSION,
  LOGOUT_PURGE_TARGETS,
  createLogoutPurgeProgress,
  decideNotesRuntimePurgeGate,
  inspectLogoutPurgeProgress,
  logoutPurgeProgressDecoder,
  recoverLogoutPurgeAfterCrash,
  transitionLogoutPurge,
  type LogoutPurgeEvent,
  type LogoutPurgeFailureReason,
  type LogoutPurgeGeneration,
  type LogoutPurgeProgress,
  type LogoutPurgeTarget,
} from '@/lib/application/logout-purge';
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
  generationOverride: LogoutPurgeGeneration = generation,
): LogoutPurgeEvent {
  return type === 'target-failed'
    ? {
        type,
        generation: generationOverride,
        target,
        reason: 'adapter-failure',
      }
    : { type, generation: generationOverride, target };
}

function advanced(
  decision: ReturnType<typeof transitionLogoutPurge>,
): LogoutPurgeProgress {
  if (decision.kind !== 'advanced') {
    throw new Error(`expected an advanced decision, received ${decision.kind}`);
  }
  return decision.progress;
}

describe('logout purge pure core', () => {
  it('starts with a copied trusted generation and the first target pending', () => {
    const progress = createLogoutPurgeProgress(Object.freeze(generation));

    expect(progress).toEqual({
      schemaVersion: LOGOUT_PURGE_SCHEMA_VERSION,
      ...generation,
      kind: 'pending',
      revision: 1,
      target: 'runtime-fence',
      attempt: 0,
    });
    expect(progress).not.toBe(generation);
  });

  it('requires every target to run and succeed before marker clear is allowed', () => {
    let progress = createLogoutPurgeProgress(generation);
    let expectedRevision = 1;

    for (const [index, target] of LOGOUT_PURGE_TARGETS.entries()) {
      const running = advanced(
        transitionLogoutPurge(
          progress,
          event('target-started', progress.target),
        ),
      );
      expectedRevision += 1;
      expect(running).toMatchObject({
        kind: 'running',
        target,
        attempt: 1,
        revision: expectedRevision,
      });

      const completed = transitionLogoutPurge(
        running,
        event('target-completed', running.target),
      );
      const nextTarget = LOGOUT_PURGE_TARGETS[index + 1];
      if (nextTarget === undefined) {
        expect(completed).toEqual({
          kind: 'ready-to-clear',
          generation,
          expectedRevision,
        });
        continue;
      }
      progress = advanced(completed);
      expectedRevision += 1;
      expect(progress).toMatchObject({
        kind: 'pending',
        target: nextTarget,
        attempt: 0,
        revision: expectedRevision,
      });
    }
  });

  it.each<Exclude<LogoutPurgeFailureReason, 'interrupted'>>([
    'blocked',
    'timeout',
    'adapter-failure',
    'unsupported-capability',
    'verification-failed',
  ])('retains %s as a typed failure and retries the same target', (reason) => {
    const pending = createLogoutPurgeProgress(generation);
    const running = advanced(
      transitionLogoutPurge(pending, event('target-started', pending.target)),
    );
    const failed = advanced(
      transitionLogoutPurge(running, {
        type: 'target-failed',
        generation,
        target: running.target,
        reason,
      }),
    );

    expect(failed).toMatchObject({
      kind: 'failed',
      target: 'runtime-fence',
      attempt: 1,
      reason,
    });
    expect(
      advanced(
        transitionLogoutPurge(failed, event('target-started', failed.target)),
      ),
    ).toMatchObject({
      kind: 'running',
      target: 'runtime-fence',
      attempt: 2,
    });
  });

  it('rejects duplicate and out-of-order events without changing progress', () => {
    const pending = createLogoutPurgeProgress(generation);
    const running = advanced(
      transitionLogoutPurge(pending, event('target-started', pending.target)),
    );

    expect(
      transitionLogoutPurge(running, event('target-started', running.target)),
    ).toEqual({
      kind: 'rejected',
      progress: running,
      reason: 'target-already-running',
    });
    expect(
      transitionLogoutPurge(pending, event('target-completed', pending.target)),
    ).toEqual({
      kind: 'rejected',
      progress: pending,
      reason: 'target-not-running',
    });
    expect(
      transitionLogoutPurge(running, event('target-completed', 'peer-tabs')),
    ).toEqual({
      kind: 'rejected',
      progress: running,
      reason: 'target-mismatch',
    });
  });

  it.each([
    ['account', { ...generation, accountId: sessionFixtureIds.otherAccountId }],
    ['Vault', { ...generation, vaultId: sessionFixtureIds.otherVaultId }],
    ['session', { ...generation, sessionId: sessionFixtureIds.nextSessionId }],
    [
      'session epoch',
      { ...generation, sessionEpoch: sessionFixtureIds.nextEpoch },
    ],
  ] satisfies ReadonlyArray<readonly [string, LogoutPurgeGeneration]>)(
    'rejects an event from another %s generation',
    (_label, otherGeneration) => {
      const progress = createLogoutPurgeProgress(generation);

      expect(
        transitionLogoutPurge(
          progress,
          event('target-started', progress.target, otherGeneration),
        ),
      ).toEqual({
        kind: 'rejected',
        progress,
        reason: 'generation-mismatch',
      });
    },
  );

  it('converts a crash during running work into an interrupted retry', () => {
    const pending = createLogoutPurgeProgress(generation);
    const running = advanced(
      transitionLogoutPurge(pending, event('target-started', pending.target)),
    );

    expect(recoverLogoutPurgeAfterCrash(running)).toEqual({
      kind: 'advanced',
      progress: {
        ...running,
        kind: 'failed',
        revision: running.revision + 1,
        reason: 'interrupted',
      },
    });
    expect(recoverLogoutPurgeAfterCrash(pending)).toEqual({
      kind: 'advanced',
      progress: pending,
    });
  });

  it('fails closed when attempt or revision counters are exhausted', () => {
    const exhaustedAttempt: LogoutPurgeProgress = {
      ...createLogoutPurgeProgress(generation),
      kind: 'failed',
      attempt: Number.MAX_SAFE_INTEGER,
      reason: 'timeout',
    };
    expect(
      transitionLogoutPurge(
        exhaustedAttempt,
        event('target-started', exhaustedAttempt.target),
      ),
    ).toEqual({
      kind: 'rejected',
      progress: exhaustedAttempt,
      reason: 'attempt-exhausted',
    });

    const exhaustedRevision: LogoutPurgeProgress = {
      ...createLogoutPurgeProgress(generation),
      revision: Number.MAX_SAFE_INTEGER,
    };
    expect(
      transitionLogoutPurge(
        exhaustedRevision,
        event('target-started', exhaustedRevision.target),
      ),
    ).toEqual({
      kind: 'rejected',
      progress: exhaustedRevision,
      reason: 'revision-exhausted',
    });
  });
});

describe('logout purge progress boundary', () => {
  it('round-trips every durable state without accepting unknown fields', () => {
    const pending = createLogoutPurgeProgress(generation);
    const running = advanced(
      transitionLogoutPurge(pending, event('target-started', pending.target)),
    );
    const failed = advanced(
      transitionLogoutPurge(running, event('target-failed', running.target)),
    );

    for (const progress of [pending, running, failed]) {
      expect(logoutPurgeProgressDecoder.decode(progress)).toEqual({
        ok: true,
        value: progress,
      });
      expect(inspectLogoutPurgeProgress(progress)).toEqual({
        kind: 'loaded',
        progress,
      });
    }
    expect(
      logoutPurgeProgressDecoder.decode({ ...pending, content: 'secret' }),
    ).toMatchObject({ ok: false });
  });

  it('decodes pending, running, and failed progress at every purge target', () => {
    let pending = createLogoutPurgeProgress(generation);

    for (const target of LOGOUT_PURGE_TARGETS) {
      expect(pending.target).toBe(target);
      expect(logoutPurgeProgressDecoder.decode(pending)).toMatchObject({
        ok: true,
      });
      const running = advanced(
        transitionLogoutPurge(pending, event('target-started', pending.target)),
      );
      expect(logoutPurgeProgressDecoder.decode(running)).toMatchObject({
        ok: true,
      });
      const failed = advanced(
        transitionLogoutPurge(running, event('target-failed', running.target)),
      );
      expect(logoutPurgeProgressDecoder.decode(failed)).toMatchObject({
        ok: true,
      });
      const retrying = advanced(
        transitionLogoutPurge(failed, event('target-started', failed.target)),
      );
      const completed = transitionLogoutPurge(
        retrying,
        event('target-completed', retrying.target),
      );
      if (completed.kind === 'ready-to-clear') break;
      pending = advanced(completed);
    }
  });

  it('distinguishes no marker, corrupt marker, and unknown schema version', () => {
    expect(inspectLogoutPurgeProgress(undefined)).toEqual({ kind: 'none' });
    expect(inspectLogoutPurgeProgress(null)).toEqual({
      kind: 'recovery-required',
      reason: 'invalid-marker',
    });
    expect(
      inspectLogoutPurgeProgress({ schemaVersion: 'logout-purge/v2' }),
    ).toEqual({
      kind: 'recovery-required',
      reason: 'unsupported-version',
    });
    expect(
      inspectLogoutPurgeProgress({
        ...createLogoutPurgeProgress(generation),
        attempt: 1,
      }),
    ).toEqual({
      kind: 'recovery-required',
      reason: 'invalid-marker',
    });
  });

  it('allows Notes runtime only when the progress boundary proves no marker exists', () => {
    const pending = inspectLogoutPurgeProgress(
      createLogoutPurgeProgress(generation),
    );
    expect(decideNotesRuntimePurgeGate({ kind: 'none' })).toEqual({
      kind: 'allowed',
    });
    expect(decideNotesRuntimePurgeGate(pending)).toEqual({
      kind: 'blocked',
      reason: 'purge-pending',
    });
    expect(
      decideNotesRuntimePurgeGate({
        kind: 'recovery-required',
        reason: 'invalid-marker',
      }),
    ).toEqual({
      kind: 'blocked',
      reason: 'progress-recovery-required',
    });
    expect(decideNotesRuntimePurgeGate({ kind: 'unavailable' })).toEqual({
      kind: 'blocked',
      reason: 'progress-unavailable',
    });
  });
});
