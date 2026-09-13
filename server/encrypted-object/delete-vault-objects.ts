import { assertNever } from '../../lib/shared/invariant';
import {
  evaluateVaultPrivateObjectPurge,
  planDeleteAttempt,
  planVaultPrivateObjectPurgeAttempt,
} from './core';
import type {
  VaultPrivateObjectPurgePort,
  VaultPrivateObjectPurgeResult,
} from './public';
import type {
  DeleteOutboxMutationResult,
  PrivateObjectDeleteResult,
  PrivateObjectStoragePort,
  VaultObjectDeleteOutboxDirectory,
} from './ports';

export type VaultPrivateObjectPurgePolicy = {
  readonly batchLimit: number;
  readonly retryDelayMs: number;
};

export function createVaultPrivateObjectPurge(input: {
  readonly scope: Parameters<
    VaultPrivateObjectPurgePort['purgeVaultPrivateObjects']
  >[0]['scope'];
  readonly outboxes: VaultObjectDeleteOutboxDirectory;
  readonly objects: PrivateObjectStoragePort;
  readonly policy: VaultPrivateObjectPurgePolicy;
}): VaultPrivateObjectPurgePort {
  return {
    async purgeVaultPrivateObjects(command) {
      const plan = planVaultPrivateObjectPurgeAttempt({
        scopeMatches:
          command.scope.accountId === input.scope.accountId &&
          command.scope.vaultId === input.scope.vaultId,
        attemptedAt: command.attemptedAt,
        retryDelayMs: input.policy.retryDelayMs,
        batchLimit: input.policy.batchLimit,
      });
      if (plan.kind === 'rejected') {
        return {
          kind: 'terminal-failure',
          reason:
            plan.reason === 'scope-mismatch'
              ? 'owner-mismatch'
              : 'invalid-command',
        };
      }

      let opened: Awaited<ReturnType<typeof input.outboxes.open>>;
      try {
        opened = await input.outboxes.open(command.scope);
      } catch {
        return retryable('outbox-unavailable');
      }
      if (opened.kind === 'owner-mismatch') {
        return { kind: 'terminal-failure', reason: 'owner-mismatch' };
      }

      const outbox = opened.repository;
      let pendingBefore: number;
      try {
        pendingBefore = await outbox.countPending();
      } catch {
        return retryable('outbox-unavailable');
      }
      if (pendingBefore === 0) {
        return evaluateVaultPrivateObjectPurge({
          pendingBefore,
          selected: 0,
          confirmed: 0,
          storageFailures: 0,
          pendingAfter: 0,
        });
      }

      let entries: Awaited<ReturnType<typeof outbox.listReady>>;
      try {
        entries = await outbox.listReady({
          now: plan.attemptedAt,
          limit: plan.batchLimit,
        });
      } catch {
        return retryable('outbox-unavailable');
      }

      let confirmed = 0;
      let storageFailures = 0;
      for (const entry of entries) {
        let deletion: PrivateObjectDeleteResult | undefined;
        try {
          deletion = await input.objects.delete(entry.objectKey);
        } catch {
          storageFailures += 1;
        }

        const attempt = planDeleteAttempt({
          entry,
          succeeded:
            deletion === undefined ? false : deleteWasConfirmed(deletion),
          attemptedAt: plan.attemptedAt,
          retryDelayMs: plan.retryDelayMs,
        });
        let mutation: DeleteOutboxMutationResult;
        try {
          mutation =
            attempt.kind === 'complete'
              ? await outbox.confirmDelete(entry)
              : await outbox.rescheduleDelete(attempt.entry);
        } catch {
          return retryable('delete-confirmation-unavailable');
        }
        if (mutation.kind === 'conflict') {
          return retryable('delete-confirmation-unavailable');
        }
        if (attempt.kind === 'complete') confirmed += 1;
      }

      let pendingAfter: number;
      try {
        pendingAfter = await outbox.countPending();
      } catch {
        return retryable('outbox-unavailable');
      }
      return evaluateVaultPrivateObjectPurge({
        pendingBefore,
        selected: entries.length,
        confirmed,
        storageFailures,
        pendingAfter,
      });
    },
  };
}

function deleteWasConfirmed(result: PrivateObjectDeleteResult): true {
  switch (result.kind) {
    case 'deleted':
    case 'not-found':
      return true;
    default:
      return assertNever(result, 'Unsupported private object delete result');
  }
}

function retryable(
  reason: Extract<
    VaultPrivateObjectPurgeResult,
    { readonly kind: 'retryable-failure' }
  >['reason'],
): VaultPrivateObjectPurgeResult {
  return { kind: 'retryable-failure', reason };
}
