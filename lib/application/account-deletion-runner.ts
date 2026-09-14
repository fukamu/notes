import {
  accountDeletionIdempotencyKeyDecoder,
  createAccountDeletionHandoff,
  inspectAccountDeletionHandoff,
  planAccountDeletionLocalPurgeCompleted,
  planAccountDeletionRevokeAccepted,
  planAccountDeletionServerAccepted,
  planAccountDeletionStartAccepted,
  sameAccountDeletionGeneration,
  type AccountDeletionHandoff,
  type AccountDeletionHandoffClear,
  type AccountDeletionHandoffProgressPort,
  type AccountDeletionHandoffRunner,
  type AccountDeletionHandoffTransition,
  type AccountDeletionHandoffWrite,
  type AccountDeletionIdempotencyKeyGeneratorPort,
  type AccountDeletionRemotePort,
  type AccountDeletionRemoteResult,
  type AccountDeletionRunFailure,
  type AccountDeletionRunResult,
  type AccountDeletionServerStatus,
} from '@/lib/application/account-deletion-handoff';
import type { LogoutPurgeRunner } from '@/lib/application/logout-purge-runner';
import type { LogoutPurgeGeneration } from '@/lib/application/logout-purge';
import { assertNever } from '@/lib/shared/invariant';

export type AccountDeletionClockPort = { readonly now: () => unknown };

/**
 * Coordinates only the browser handoff. Server deletion remains authoritative,
 * while the existing logout purge runner remains the sole local-content eraser.
 */
export function createAccountDeletionHandoffRunner(input: {
  readonly progress: AccountDeletionHandoffProgressPort;
  readonly remote: AccountDeletionRemotePort;
  readonly idempotencyKeys: AccountDeletionIdempotencyKeyGeneratorPort;
  readonly logoutPurge: LogoutPurgeRunner;
  readonly clock: AccountDeletionClockPort;
}): AccountDeletionHandoffRunner {
  return {
    async begin(generation) {
      const stored = await readHandoff(input.progress);
      if (stored.kind === 'failed') return stored.result;
      if (stored.kind === 'loaded') {
        if (!sameAccountDeletionGeneration(stored.handoff, generation)) {
          return failure('another-deletion-pending');
        }
        return drivePrePurge(stored.handoff, input);
      }

      let generatedValue: unknown;
      try {
        generatedValue = input.idempotencyKeys.create();
      } catch {
        return failure('progress-unavailable');
      }
      const generated =
        accountDeletionIdempotencyKeyDecoder.decode(generatedValue);
      if (!generated.ok) return failure('progress-unavailable');
      const handoff = createAccountDeletionHandoff(generation, generated.value);
      const written = await writeHandoff(input.progress, {
        kind: 'create',
        handoff,
      });
      if (written.kind === 'failed') return written.result;
      return drivePrePurge(handoff, input);
    },

    async recover() {
      const stored = await readHandoff(input.progress);
      if (stored.kind === 'failed') return stored.result;
      if (stored.kind === 'none') return { kind: 'idle' };
      if (stored.handoff.kind === 'server-pending') {
        return pending(stored.handoff.server, 'deleted');
      }
      return drivePrePurge(stored.handoff, input);
    },

    async resumeServer() {
      const stored = await readHandoff(input.progress);
      if (stored.kind === 'failed') return stored.result;
      if (stored.kind === 'none') return { kind: 'idle' };
      if (stored.handoff.kind !== 'server-pending') {
        return drivePrePurge(stored.handoff, input);
      }
      const server = stored.handoff.server;
      const due = dueDecision(server, input.clock);
      if (due === 'unavailable') return failure('remote-unavailable');
      if (due === 'not-due') {
        return pending(server, 'deleted');
      }
      const remote = await callRemote(() =>
        input.remote.resume({
          continuationToken: server.continuationToken,
        }),
      );
      if (remote.kind === 'rejected') return remoteFailure(remote);
      return persistServerResult(stored.handoff, remote.status, input.progress);
    },
  };
}

type RunnerDependencies = {
  readonly progress: AccountDeletionHandoffProgressPort;
  readonly remote: AccountDeletionRemotePort;
  readonly logoutPurge: LogoutPurgeRunner;
  readonly clock: AccountDeletionClockPort;
};

async function drivePrePurge(
  handoff: AccountDeletionHandoff,
  input: RunnerDependencies,
): Promise<AccountDeletionRunResult> {
  let current: AccountDeletionHandoff = handoff;

  if (current.kind === 'server-pending') {
    return pending(current.server, 'deleted');
  }

  if (current.kind === 'starting') {
    const idempotencyKey = current.idempotencyKey;
    const remote = await callRemote(() =>
      input.remote.start({ idempotencyKey }),
    );
    if (remote.kind === 'rejected') return remoteFailure(remote);
    const persisted = await persistTransition(
      current,
      planAccountDeletionStartAccepted(current, remote.status),
      input.progress,
    );
    if (persisted.kind === 'failed') return persisted.result;
    if (persisted.kind === 'cleared') return persisted.result;
    current = persisted.handoff;
  }

  if (current.kind === 'revoke-pending') {
    const due = dueDecision(current.server, input.clock);
    if (due === 'unavailable') return failure('remote-unavailable');
    if (due === 'not-due') return pending(current.server, 'retained');
    const continuationToken = current.server.continuationToken;
    const remote = await callRemote(() =>
      input.remote.resume({
        continuationToken,
      }),
    );
    if (remote.kind === 'rejected') return remoteFailure(remote);
    const persisted = await persistTransition(
      current,
      planAccountDeletionRevokeAccepted(current, remote.status),
      input.progress,
    );
    if (persisted.kind === 'failed') return persisted.result;
    if (persisted.kind === 'cleared') return persisted.result;
    current = persisted.handoff;
    if (current.kind === 'revoke-pending') {
      return pending(current.server, 'retained');
    }
  }

  if (current.kind !== 'purge-pending') {
    return current.kind === 'server-pending'
      ? pending(current.server, 'deleted')
      : failure('invalid-state');
  }

  const purged = await input.logoutPurge.run(generationSnapshot(current));
  if (purged.kind !== 'completed') {
    return failure(localPurgeFailure(purged));
  }
  const persisted = await persistTransition(
    current,
    planAccountDeletionLocalPurgeCompleted(current),
    input.progress,
  );
  if (persisted.kind === 'failed' || persisted.kind === 'cleared') {
    return persisted.result;
  }
  return persisted.handoff.kind === 'server-pending'
    ? pending(persisted.handoff.server, 'deleted')
    : failure('invalid-state');
}

async function persistServerResult(
  handoff: Extract<AccountDeletionHandoff, { readonly kind: 'server-pending' }>,
  status: AccountDeletionServerStatus,
  progress: AccountDeletionHandoffProgressPort,
): Promise<AccountDeletionRunResult> {
  const persisted = await persistTransition(
    handoff,
    planAccountDeletionServerAccepted(handoff, status),
    progress,
  );
  if (persisted.kind === 'failed' || persisted.kind === 'cleared') {
    return persisted.result;
  }
  return persisted.handoff.kind === 'server-pending'
    ? pending(persisted.handoff.server, 'deleted')
    : failure('invalid-state');
}

type PersistTransitionResult =
  | { readonly kind: 'advanced'; readonly handoff: AccountDeletionHandoff }
  | { readonly kind: 'cleared'; readonly result: AccountDeletionRunResult }
  | { readonly kind: 'failed'; readonly result: AccountDeletionRunResult };

async function persistTransition(
  current: AccountDeletionHandoff,
  transition: AccountDeletionHandoffTransition,
  progress: AccountDeletionHandoffProgressPort,
): Promise<PersistTransitionResult> {
  switch (transition.kind) {
    case 'rejected':
      return { kind: 'failed', result: failure('invalid-state') };
    case 'advanced': {
      const written = await writeHandoff(progress, {
        kind: 'replace',
        expectedRevision: current.revision,
        handoff: transition.handoff,
      });
      return written.kind === 'failed'
        ? written
        : { kind: 'advanced', handoff: transition.handoff };
    }
    case 'ready-to-clear': {
      const cleared = await clearHandoff(progress, {
        generation: transition.generation,
        expectedRevision: transition.expectedRevision,
      });
      return cleared.kind === 'failed'
        ? cleared
        : {
            kind: 'cleared',
            result: {
              kind: 'terminal',
              status: transition.terminalStatus,
            },
          };
    }
    default:
      return assertNever(transition, 'Unsupported account deletion transition');
  }
}

type ReadHandoffResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'loaded'; readonly handoff: AccountDeletionHandoff }
  | { readonly kind: 'failed'; readonly result: AccountDeletionRunResult };

async function readHandoff(
  progress: AccountDeletionHandoffProgressPort,
): Promise<ReadHandoffResult> {
  let raw: unknown;
  try {
    raw = await progress.read();
  } catch {
    return { kind: 'failed', result: failure('progress-unavailable') };
  }
  const inspected = inspectAccountDeletionHandoff(raw);
  switch (inspected.kind) {
    case 'none':
      return { kind: 'none' };
    case 'loaded':
      return { kind: 'loaded', handoff: inspected.handoff };
    case 'recovery-required':
      return {
        kind: 'failed',
        result: failure('progress-recovery-required'),
      };
    default:
      return assertNever(inspected, 'Unsupported handoff inspection');
  }
}

type PersistenceResult =
  | { readonly kind: 'written' | 'cleared' }
  | { readonly kind: 'failed'; readonly result: AccountDeletionRunResult };

async function writeHandoff(
  progress: AccountDeletionHandoffProgressPort,
  write: AccountDeletionHandoffWrite,
): Promise<PersistenceResult> {
  try {
    const result = await progress.write(write);
    if (result === true) return { kind: 'written' };
    return {
      kind: 'failed',
      result: failure(
        result === false
          ? 'concurrent-progress-change'
          : 'progress-unavailable',
      ),
    };
  } catch {
    return { kind: 'failed', result: failure('progress-unavailable') };
  }
}

async function clearHandoff(
  progress: AccountDeletionHandoffProgressPort,
  clear: AccountDeletionHandoffClear,
): Promise<PersistenceResult> {
  try {
    const result = await progress.clear(clear);
    if (result === true) return { kind: 'cleared' };
    return {
      kind: 'failed',
      result: failure(
        result === false
          ? 'concurrent-progress-change'
          : 'progress-unavailable',
      ),
    };
  } catch {
    return { kind: 'failed', result: failure('progress-unavailable') };
  }
}

async function callRemote(
  effect: () => Promise<AccountDeletionRemoteResult>,
): Promise<AccountDeletionRemoteResult> {
  try {
    return await effect();
  } catch {
    return { kind: 'rejected', reason: 'remote-unavailable' };
  }
}

function dueDecision(
  status: Extract<
    AccountDeletionServerStatus,
    { readonly kind: 'in-progress' | 'retry-wait' }
  >,
  clock: AccountDeletionClockPort,
): 'due' | 'not-due' | 'unavailable' {
  if (status.kind === 'in-progress') return 'due';
  let value: unknown;
  try {
    value = clock.now();
  } catch {
    return 'unavailable';
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    return 'unavailable';
  }
  return value >= status.retryAt ? 'due' : 'not-due';
}

function remoteFailure(
  result: Extract<AccountDeletionRemoteResult, { readonly kind: 'rejected' }>,
): AccountDeletionRunResult {
  return failure(result.reason);
}

function localPurgeFailure(
  result: Exclude<
    Awaited<ReturnType<LogoutPurgeRunner['run']>>,
    { readonly kind: 'completed' }
  >,
): AccountDeletionRunFailure {
  if (result.kind === 'failed') {
    return result.reason === 'concurrent-progress-change'
      ? 'concurrent-progress-change'
      : result.reason === 'progress-unavailable'
        ? 'progress-unavailable'
        : 'local-purge-failed';
  }
  const reason = result.reason;
  switch (reason) {
    case 'another-purge-pending':
      return 'another-deletion-pending';
    case 'concurrent-progress-change':
      return 'concurrent-progress-change';
    case 'progress-recovery-required':
      return 'progress-recovery-required';
    case 'progress-unavailable':
      return 'progress-unavailable';
    case 'blocked':
    case 'timeout':
    case 'adapter-failure':
    case 'unsupported-capability':
    case 'verification-failed':
    case 'interrupted':
      return 'local-purge-failed';
    default:
      return assertNever(reason, 'Unsupported local purge failure');
  }
}

function generationSnapshot(
  handoff: AccountDeletionHandoff,
): LogoutPurgeGeneration {
  return {
    accountId: handoff.accountId,
    vaultId: handoff.vaultId,
    sessionId: handoff.sessionId,
    sessionEpoch: handoff.sessionEpoch,
  };
}

function pending(
  status: Extract<
    AccountDeletionServerStatus,
    { readonly kind: 'in-progress' | 'retry-wait' }
  >,
  localContent: 'retained' | 'deleted',
): AccountDeletionRunResult {
  return { kind: 'pending', localContent, status };
}

function failure(reason: AccountDeletionRunFailure): AccountDeletionRunResult {
  return { kind: 'failed', reason };
}
