import {
  createLogoutPurgeProgress,
  inspectLogoutPurgeProgress,
  recoverLogoutPurgeAfterCrash,
  sameLogoutPurgeGeneration,
  transitionLogoutPurge,
  type InspectLogoutPurgeProgressResult,
  type LogoutPurgeEvent,
  type LogoutPurgeGeneration,
  type LogoutPurgeProgress,
  type LogoutPurgeTransitionDecision,
} from '@/lib/application/logout-purge';

export type LogoutPurgeProgressWrite =
  | {
      readonly kind: 'create';
      readonly progress: LogoutPurgeProgress;
    }
  | {
      readonly kind: 'replace';
      readonly expectedRevision: number;
      readonly progress: LogoutPurgeProgress;
    };

export type LogoutPurgeProgressClear = {
  readonly generation: LogoutPurgeGeneration;
  readonly expectedRevision: number;
};

export type LogoutPurgeProgressPort = {
  read: () => Promise<unknown>;
  /** Returns true only after a compare-and-swap write commits. */
  write: (input: LogoutPurgeProgressWrite) => Promise<unknown>;
  /** Returns true only if the expected generation/revision marker is absent. */
  clear: (input: LogoutPurgeProgressClear) => Promise<unknown>;
};

export type ReadLogoutPurgeProgressResult =
  | InspectLogoutPurgeProgressResult
  | { readonly kind: 'unavailable' };

export type StartOrResumeLogoutPurgeResult =
  | {
      readonly kind: 'started' | 'resumed' | 'recovered';
      readonly progress: LogoutPurgeProgress;
    }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'another-purge-pending'
        | 'concurrent-progress-change'
        | 'progress-recovery-required'
        | 'progress-unavailable';
    };

export type ApplyLogoutPurgeEventResult =
  | { readonly kind: 'advanced'; readonly progress: LogoutPurgeProgress }
  | { readonly kind: 'completed' }
  | {
      readonly kind: 'rejected';
      readonly reason: Extract<
        LogoutPurgeTransitionDecision,
        { kind: 'rejected' }
      >['reason'];
    }
  | {
      readonly kind: 'failed';
      readonly reason: 'concurrent-progress-change' | 'progress-unavailable';
    };

export async function readLogoutPurgeProgress(
  port: LogoutPurgeProgressPort,
): Promise<ReadLogoutPurgeProgressResult> {
  try {
    return inspectLogoutPurgeProgress(await port.read());
  } catch {
    return { kind: 'unavailable' };
  }
}

/** Creates once or resumes only the exact logout generation already stored. */
export async function startOrResumeLogoutPurge(
  generation: LogoutPurgeGeneration,
  port: LogoutPurgeProgressPort,
): Promise<StartOrResumeLogoutPurgeResult> {
  const stored = await readLogoutPurgeProgress(port);
  switch (stored.kind) {
    case 'none': {
      const progress = createLogoutPurgeProgress(generation);
      const written = await writeProgress(port, { kind: 'create', progress });
      return written.kind === 'written'
        ? { kind: 'started', progress }
        : { kind: 'blocked', reason: written.reason };
    }
    case 'loaded': {
      if (!sameLogoutPurgeGeneration(stored.progress, generation)) {
        return { kind: 'blocked', reason: 'another-purge-pending' };
      }
      const recovered = recoverLogoutPurgeAfterCrash(stored.progress);
      switch (recovered.kind) {
        case 'rejected':
        case 'ready-to-clear':
          return { kind: 'blocked', reason: 'progress-recovery-required' };
        case 'advanced':
          break;
      }
      if (recovered.progress === stored.progress) {
        return { kind: 'resumed', progress: stored.progress };
      }
      const written = await writeProgress(port, {
        kind: 'replace',
        expectedRevision: stored.progress.revision,
        progress: recovered.progress,
      });
      return written.kind === 'written'
        ? { kind: 'recovered', progress: recovered.progress }
        : { kind: 'blocked', reason: written.reason };
    }
    case 'recovery-required':
      return { kind: 'blocked', reason: 'progress-recovery-required' };
    case 'unavailable':
      return { kind: 'blocked', reason: 'progress-unavailable' };
  }
}

/** Persists an accepted transition with CAS, or clears only final verification. */
export async function applyLogoutPurgeEvent(
  progress: LogoutPurgeProgress,
  event: LogoutPurgeEvent,
  port: LogoutPurgeProgressPort,
): Promise<ApplyLogoutPurgeEventResult> {
  const decision = transitionLogoutPurge(progress, event);
  switch (decision.kind) {
    case 'rejected':
      return { kind: 'rejected', reason: decision.reason };
    case 'advanced': {
      const written = await writeProgress(port, {
        kind: 'replace',
        expectedRevision: progress.revision,
        progress: decision.progress,
      });
      return written.kind === 'written'
        ? { kind: 'advanced', progress: decision.progress }
        : { kind: 'failed', reason: written.reason };
    }
    case 'ready-to-clear': {
      const cleared = await clearProgress(port, {
        generation: decision.generation,
        expectedRevision: decision.expectedRevision,
      });
      return cleared.kind === 'cleared'
        ? { kind: 'completed' }
        : { kind: 'failed', reason: cleared.reason };
    }
  }
}

type WriteProgressResult =
  | { readonly kind: 'written' }
  | {
      readonly kind: 'failed';
      readonly reason: 'concurrent-progress-change' | 'progress-unavailable';
    };

async function writeProgress(
  port: LogoutPurgeProgressPort,
  input: LogoutPurgeProgressWrite,
): Promise<WriteProgressResult> {
  try {
    const result = await port.write(input);
    if (result === true) return { kind: 'written' };
    return {
      kind: 'failed',
      reason:
        result === false
          ? 'concurrent-progress-change'
          : 'progress-unavailable',
    };
  } catch {
    return { kind: 'failed', reason: 'progress-unavailable' };
  }
}

type ClearProgressResult =
  | { readonly kind: 'cleared' }
  | {
      readonly kind: 'failed';
      readonly reason: 'concurrent-progress-change' | 'progress-unavailable';
    };

async function clearProgress(
  port: LogoutPurgeProgressPort,
  input: LogoutPurgeProgressClear,
): Promise<ClearProgressResult> {
  try {
    const result = await port.clear(input);
    if (result === true) return { kind: 'cleared' };
    return {
      kind: 'failed',
      reason:
        result === false
          ? 'concurrent-progress-change'
          : 'progress-unavailable',
    };
  } catch {
    return { kind: 'failed', reason: 'progress-unavailable' };
  }
}
