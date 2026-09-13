import {
  type LogoutPurgeCoordinationPort,
  type LogoutPeerQuiescenceLease,
  type LogoutPurgeOwnerLease,
} from '@/lib/application/logout-runtime-coordination';
import { logoutPurgeFailureReasonForCoordination } from '@/lib/application/logout-coordination';
import {
  LOGOUT_PURGE_TARGETS,
  type LogoutPurgeFailureReason,
  type LogoutPurgeGeneration,
  type LogoutPurgeProgress,
  type LogoutPurgeTarget,
} from '@/lib/application/logout-purge';
import {
  applyLogoutPurgeEvent,
  startOrResumeLogoutPurge,
  type LogoutPurgeProgressPort,
} from '@/lib/application/logout-purge-progress';
import { assertNever } from '@/lib/shared/invariant';

export type LogoutPurgeTargetResult =
  | { readonly kind: 'completed' }
  | {
      readonly kind: 'failed';
      readonly reason: Exclude<LogoutPurgeFailureReason, 'interrupted'>;
    };

export type LogoutPurgeTargetPort = {
  closeLocalRuntime: (
    generation: LogoutPurgeGeneration,
  ) => Promise<LogoutPurgeTargetResult>;
  resetGraphWorker: () => Promise<LogoutPurgeTargetResult>;
  purgeServiceWorkerCache: () => Promise<LogoutPurgeTargetResult>;
  deleteVaultDatabase: (
    generation: LogoutPurgeGeneration,
  ) => Promise<LogoutPurgeTargetResult>;
  verifyDeletion: (
    generation: LogoutPurgeGeneration,
  ) => Promise<LogoutPurgeTargetResult>;
};

export type RunLogoutPurgeResult =
  | {
      readonly kind: 'completed';
      readonly completionAnnouncement: 'sent' | 'failed';
    }
  | {
      readonly kind: 'blocked';
      readonly reason:
        | 'another-purge-pending'
        | 'concurrent-progress-change'
        | 'progress-recovery-required'
        | 'progress-unavailable'
        | LogoutPurgeFailureReason;
    }
  | {
      readonly kind: 'failed';
      readonly target: LogoutPurgeTarget;
      readonly reason:
        | Exclude<LogoutPurgeFailureReason, 'interrupted'>
        | 'concurrent-progress-change'
        | 'progress-unavailable';
    };

export type LogoutPurgeRunner = {
  run: (generation: LogoutPurgeGeneration) => Promise<RunLogoutPurgeResult>;
};

/**
 * Persists every state transition before or after its browser effect. The
 * ordered pure state machine remains the only authority that can clear the
 * marker and report completion.
 */
export function createLogoutPurgeRunner(input: {
  readonly progress: LogoutPurgeProgressPort;
  readonly coordination: LogoutPurgeCoordinationPort;
  readonly targets: LogoutPurgeTargetPort;
}): LogoutPurgeRunner {
  return {
    async run(generation) {
      const started = await startOrResumeLogoutPurge(
        generation,
        input.progress,
      );
      if (started.kind === 'blocked') return started;

      const owner = await input.coordination.acquireOwner(generation);
      if (owner.kind === 'failed') {
        return {
          kind: 'blocked',
          reason: logoutPurgeFailureReasonForCoordination(owner.reason),
        };
      }

      let peerLease: LogoutPeerQuiescenceLease | undefined;
      let coordinationAttempt: number | undefined;
      try {
        let progress = started.progress;
        for (const expectedTarget of LOGOUT_PURGE_TARGETS) {
          if (progress.target !== expectedTarget) continue;

          const running = await applyLogoutPurgeEvent(
            progress,
            {
              type: 'target-started',
              generation,
              target: progress.target,
            },
            input.progress,
          );
          if (running.kind !== 'advanced') {
            return transitionFailure(progress.target, running);
          }
          progress = running.progress;

          if (
            targetNeedsPeerQuiescence(progress.target) &&
            peerLease === undefined
          ) {
            coordinationAttempt = progress.revision;
            const quiescence =
              await owner.lease.quiescePeers(coordinationAttempt);
            if (quiescence.kind === 'failed') {
              return await persistTargetFailure(
                progress,
                generation,
                logoutPurgeFailureReasonForCoordination(
                  coordinationFailure(quiescence.reason),
                ),
                input.progress,
              );
            }
            peerLease = quiescence.lease;
          }

          const effect = await runTargetEffect(
            progress.target,
            generation,
            input.targets,
          );
          if (effect.kind === 'failed') {
            return await persistTargetFailure(
              progress,
              generation,
              effect.reason,
              input.progress,
            );
          }

          const completed = await applyLogoutPurgeEvent(
            progress,
            {
              type: 'target-completed',
              generation,
              target: progress.target,
            },
            input.progress,
          );
          if (completed.kind === 'completed') {
            const announcementAttempt =
              coordinationAttempt ?? progress.revision;
            return {
              kind: 'completed',
              completionAnnouncement:
                owner.lease.announceCompleted(announcementAttempt),
            };
          }
          if (completed.kind !== 'advanced') {
            return transitionFailure(progress.target, completed);
          }
          progress = completed.progress;
        }
        return {
          kind: 'failed',
          target: progress.target,
          reason: 'verification-failed',
        };
      } finally {
        await releaseLeases(peerLease, owner.lease);
      }
    },
  };
}

function targetNeedsPeerQuiescence(target: LogoutPurgeTarget): boolean {
  return (
    LOGOUT_PURGE_TARGETS.indexOf(target) >=
    LOGOUT_PURGE_TARGETS.indexOf('peer-tabs')
  );
}

async function runTargetEffect(
  target: LogoutPurgeTarget,
  generation: LogoutPurgeGeneration,
  port: LogoutPurgeTargetPort,
): Promise<LogoutPurgeTargetResult> {
  try {
    switch (target) {
      case 'runtime-fence':
      case 'peer-tabs':
        return { kind: 'completed' };
      case 'local-runtime':
        return await port.closeLocalRuntime(generation);
      case 'graph-worker':
        return await port.resetGraphWorker();
      case 'service-worker-cache':
        return await port.purgeServiceWorkerCache();
      case 'vault-database':
        return await port.deleteVaultDatabase(generation);
      case 'deletion-verification':
        return await port.verifyDeletion(generation);
      default:
        return assertNever(target, 'Unsupported logout purge target');
    }
  } catch {
    return { kind: 'failed', reason: 'adapter-failure' };
  }
}

async function persistTargetFailure(
  progress: LogoutPurgeProgress,
  generation: LogoutPurgeGeneration,
  reason: Exclude<LogoutPurgeFailureReason, 'interrupted'>,
  port: LogoutPurgeProgressPort,
): Promise<RunLogoutPurgeResult> {
  const persisted = await applyLogoutPurgeEvent(
    progress,
    {
      type: 'target-failed',
      generation,
      target: progress.target,
      reason,
    },
    port,
  );
  if (persisted.kind === 'advanced') {
    return { kind: 'failed', target: progress.target, reason };
  }
  return transitionFailure(progress.target, persisted);
}

function transitionFailure(
  target: LogoutPurgeTarget,
  result: Awaited<ReturnType<typeof applyLogoutPurgeEvent>>,
): RunLogoutPurgeResult {
  switch (result.kind) {
    case 'failed':
      return { kind: 'failed', target, reason: result.reason };
    case 'rejected':
    case 'advanced':
    case 'completed':
      return { kind: 'failed', target, reason: 'verification-failed' };
    default:
      return assertNever(result, 'Unsupported purge transition failure');
  }
}

function coordinationFailure(
  reason:
    | 'contended'
    | 'timeout'
    | 'adapter-failure'
    | 'unsupported-capability'
    | 'already-coordinating'
    | 'invalid-attempt',
): 'contended' | 'timeout' | 'adapter-failure' | 'unsupported-capability' {
  switch (reason) {
    case 'contended':
    case 'timeout':
    case 'adapter-failure':
    case 'unsupported-capability':
      return reason;
    case 'already-coordinating':
    case 'invalid-attempt':
      return 'adapter-failure';
    default:
      return assertNever(reason, 'Unsupported peer coordination failure');
  }
}

async function releaseLeases(
  peer: LogoutPeerQuiescenceLease | undefined,
  owner: LogoutPurgeOwnerLease,
): Promise<void> {
  try {
    await peer?.release();
  } finally {
    await owner.release();
  }
}
