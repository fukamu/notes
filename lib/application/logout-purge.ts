import {
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  transformDecoder,
  unionDecoder,
  type Decoder,
} from '@/lib/codec/core';
import {
  accountIdDecoder,
  sessionEpochDecoder,
  sessionIdDecoder,
  vaultIdDecoder,
  type VaultContext,
} from '@/lib/domain/identity';
import { assertNever } from '@/lib/shared/invariant';

export const LOGOUT_PURGE_SCHEMA_VERSION = 'logout-purge/v1' as const;

export const LOGOUT_PURGE_TARGETS = [
  'runtime-fence',
  'peer-tabs',
  'local-runtime',
  'graph-worker',
  'service-worker-cache',
  'vault-database',
  'deletion-verification',
] as const;

export type LogoutPurgeTarget = (typeof LOGOUT_PURGE_TARGETS)[number];

export type LogoutPurgeFailureReason =
  | 'blocked'
  | 'timeout'
  | 'adapter-failure'
  | 'unsupported-capability'
  | 'verification-failed'
  | 'interrupted';

export type LogoutPurgeGeneration = VaultContext;

type LogoutPurgeProgressBase = LogoutPurgeGeneration & {
  readonly schemaVersion: typeof LOGOUT_PURGE_SCHEMA_VERSION;
  readonly revision: number;
  readonly target: LogoutPurgeTarget;
  readonly attempt: number;
};

export type LogoutPurgeProgress =
  | (LogoutPurgeProgressBase & { readonly kind: 'pending' })
  | (LogoutPurgeProgressBase & { readonly kind: 'running' })
  | (LogoutPurgeProgressBase & {
      readonly kind: 'failed';
      readonly reason: LogoutPurgeFailureReason;
    });

export type LogoutPurgeEvent =
  | {
      readonly type: 'target-started';
      readonly generation: LogoutPurgeGeneration;
      readonly target: LogoutPurgeTarget;
    }
  | {
      readonly type: 'target-completed';
      readonly generation: LogoutPurgeGeneration;
      readonly target: LogoutPurgeTarget;
    }
  | {
      readonly type: 'target-failed';
      readonly generation: LogoutPurgeGeneration;
      readonly target: LogoutPurgeTarget;
      readonly reason: Exclude<LogoutPurgeFailureReason, 'interrupted'>;
    };

export type LogoutPurgeTransitionDecision =
  | { readonly kind: 'advanced'; readonly progress: LogoutPurgeProgress }
  | {
      readonly kind: 'ready-to-clear';
      readonly generation: LogoutPurgeGeneration;
      readonly expectedRevision: number;
    }
  | {
      readonly kind: 'rejected';
      readonly progress: LogoutPurgeProgress;
      readonly reason:
        | 'generation-mismatch'
        | 'target-mismatch'
        | 'target-not-running'
        | 'target-already-running'
        | 'attempt-exhausted'
        | 'revision-exhausted';
    };

export type InspectLogoutPurgeProgressResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'loaded'; readonly progress: LogoutPurgeProgress }
  | {
      readonly kind: 'recovery-required';
      readonly reason: 'invalid-marker' | 'unsupported-version';
    };

export type NotesRuntimePurgeGateDecision =
  | { readonly kind: 'allowed' }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'purge-pending'
        | 'progress-recovery-required'
        | 'progress-unavailable';
    };

const targetDecoder = unionDecoder(
  ...LOGOUT_PURGE_TARGETS.map((target) => literalDecoder(target)),
);
const failureReasonDecoder = unionDecoder(
  literalDecoder('blocked'),
  literalDecoder('timeout'),
  literalDecoder('adapter-failure'),
  literalDecoder('unsupported-capability'),
  literalDecoder('verification-failed'),
  literalDecoder('interrupted'),
);
const positiveIntegerDecoder = safeIntegerDecoder({
  minimum: 1,
  maximum: Number.MAX_SAFE_INTEGER,
});
const zeroDecoder = refineDecoder(
  safeIntegerDecoder({ minimum: 0, maximum: 0 }),
  (value) => value === 0,
  'expected zero',
);

const progressBaseShape = {
  schemaVersion: literalDecoder(LOGOUT_PURGE_SCHEMA_VERSION),
  accountId: accountIdDecoder,
  vaultId: vaultIdDecoder,
  sessionId: sessionIdDecoder,
  sessionEpoch: sessionEpochDecoder,
  revision: positiveIntegerDecoder,
  target: targetDecoder,
} as const;

const pendingProgressDecoder = objectDecoder({
  ...progressBaseShape,
  kind: literalDecoder('pending'),
  attempt: zeroDecoder,
});
const runningProgressDecoder = objectDecoder({
  ...progressBaseShape,
  kind: literalDecoder('running'),
  attempt: positiveIntegerDecoder,
});
const failedProgressDecoder = objectDecoder({
  ...progressBaseShape,
  kind: literalDecoder('failed'),
  attempt: positiveIntegerDecoder,
  reason: failureReasonDecoder,
});

export const logoutPurgeProgressDecoder: Decoder<LogoutPurgeProgress> =
  transformDecoder(
    unionDecoder(
      pendingProgressDecoder,
      runningProgressDecoder,
      failedProgressDecoder,
    ),
    (progress): LogoutPurgeProgress => progress,
  );

export function createLogoutPurgeProgress(
  generation: LogoutPurgeGeneration,
): LogoutPurgeProgress {
  return {
    schemaVersion: LOGOUT_PURGE_SCHEMA_VERSION,
    ...generationSnapshot(generation),
    kind: 'pending',
    revision: 1,
    target: LOGOUT_PURGE_TARGETS[0],
    attempt: 0,
  };
}

/**
 * Applies only decoded events for the exact trusted logout generation. It has
 * no clock, storage, browser, worker, or network dependencies.
 */
export function transitionLogoutPurge(
  progress: LogoutPurgeProgress,
  event: LogoutPurgeEvent,
): LogoutPurgeTransitionDecision {
  if (!sameGeneration(progress, event.generation)) {
    return rejected(progress, 'generation-mismatch');
  }
  if (progress.target !== event.target) {
    return rejected(progress, 'target-mismatch');
  }

  switch (event.type) {
    case 'target-started': {
      if (progress.kind === 'running') {
        return rejected(progress, 'target-already-running');
      }
      const attempt = incrementSafeInteger(progress.attempt);
      if (attempt === undefined) return rejected(progress, 'attempt-exhausted');
      const revision = incrementSafeInteger(progress.revision);
      if (revision === undefined)
        return rejected(progress, 'revision-exhausted');
      return {
        kind: 'advanced',
        progress: {
          ...progressBase(progress, revision),
          kind: 'running',
          attempt,
        },
      };
    }
    case 'target-failed': {
      if (progress.kind !== 'running') {
        return rejected(progress, 'target-not-running');
      }
      const revision = incrementSafeInteger(progress.revision);
      if (revision === undefined)
        return rejected(progress, 'revision-exhausted');
      return {
        kind: 'advanced',
        progress: {
          ...progressBase(progress, revision),
          kind: 'failed',
          attempt: progress.attempt,
          reason: event.reason,
        },
      };
    }
    case 'target-completed': {
      if (progress.kind !== 'running') {
        return rejected(progress, 'target-not-running');
      }
      const nextTarget = targetAfter(progress.target);
      if (nextTarget === undefined) {
        return {
          kind: 'ready-to-clear',
          generation: generationSnapshot(progress),
          expectedRevision: progress.revision,
        };
      }
      const revision = incrementSafeInteger(progress.revision);
      if (revision === undefined)
        return rejected(progress, 'revision-exhausted');
      return {
        kind: 'advanced',
        progress: {
          ...progressBase(progress, revision),
          kind: 'pending',
          target: nextTarget,
          attempt: 0,
        },
      };
    }
    default:
      return assertNever(event, 'Unsupported logout purge event');
  }
}

/** Converts work interrupted by a crash into an explicit retryable failure. */
export function recoverLogoutPurgeAfterCrash(
  progress: LogoutPurgeProgress,
): LogoutPurgeTransitionDecision {
  if (progress.kind !== 'running') {
    return { kind: 'advanced', progress };
  }
  const revision = incrementSafeInteger(progress.revision);
  if (revision === undefined) return rejected(progress, 'revision-exhausted');
  return {
    kind: 'advanced',
    progress: {
      ...progressBase(progress, revision),
      kind: 'failed',
      attempt: progress.attempt,
      reason: 'interrupted',
    },
  };
}

export function inspectLogoutPurgeProgress(
  input: unknown,
): InspectLogoutPurgeProgressResult {
  if (input === undefined) return { kind: 'none' };
  if (
    isRecord(input) &&
    'schemaVersion' in input &&
    input.schemaVersion !== LOGOUT_PURGE_SCHEMA_VERSION
  ) {
    return { kind: 'recovery-required', reason: 'unsupported-version' };
  }
  const decoded = logoutPurgeProgressDecoder.decode(input);
  return decoded.ok
    ? { kind: 'loaded', progress: decoded.value }
    : { kind: 'recovery-required', reason: 'invalid-marker' };
}

export function decideNotesRuntimePurgeGate(
  progress: InspectLogoutPurgeProgressResult | { readonly kind: 'unavailable' },
): NotesRuntimePurgeGateDecision {
  switch (progress.kind) {
    case 'none':
      return { kind: 'allowed' };
    case 'loaded':
      return { kind: 'blocked', reason: 'purge-pending' };
    case 'recovery-required':
      return { kind: 'blocked', reason: 'progress-recovery-required' };
    case 'unavailable':
      return { kind: 'blocked', reason: 'progress-unavailable' };
    default:
      return assertNever(progress, 'Unsupported logout progress inspection');
  }
}

export function sameLogoutPurgeGeneration(
  left: LogoutPurgeGeneration,
  right: LogoutPurgeGeneration,
): boolean {
  return sameGeneration(left, right);
}

function progressBase(
  progress: LogoutPurgeProgress,
  revision: number,
): LogoutPurgeProgressBase {
  return {
    schemaVersion: LOGOUT_PURGE_SCHEMA_VERSION,
    ...generationSnapshot(progress),
    revision,
    target: progress.target,
    attempt: progress.attempt,
  };
}

function generationSnapshot(
  generation: LogoutPurgeGeneration,
): LogoutPurgeGeneration {
  return {
    accountId: generation.accountId,
    vaultId: generation.vaultId,
    sessionId: generation.sessionId,
    sessionEpoch: generation.sessionEpoch,
  };
}

function sameGeneration(
  left: LogoutPurgeGeneration,
  right: LogoutPurgeGeneration,
): boolean {
  return (
    left.accountId === right.accountId &&
    left.vaultId === right.vaultId &&
    left.sessionId === right.sessionId &&
    left.sessionEpoch === right.sessionEpoch
  );
}

function incrementSafeInteger(value: number): number | undefined {
  const next = value + 1;
  return Number.isSafeInteger(next) ? next : undefined;
}

function targetAfter(target: LogoutPurgeTarget): LogoutPurgeTarget | undefined {
  const index = LOGOUT_PURGE_TARGETS.indexOf(target);
  return LOGOUT_PURGE_TARGETS[index + 1];
}

function rejected(
  progress: LogoutPurgeProgress,
  reason: Extract<
    LogoutPurgeTransitionDecision,
    { kind: 'rejected' }
  >['reason'],
): LogoutPurgeTransitionDecision {
  return { kind: 'rejected', progress, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
