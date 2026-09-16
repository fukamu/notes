import { assertNever } from '../../lib/shared/invariant';
import type { VaultPrivateObjectPurgeResult } from '../encrypted-object/public';
import {
  isValidAccountDeletionSnapshot,
  type AccountDeletionStepResult,
} from './core';
import {
  parseAccountDeletionFailureCode,
  type AccountDeletionAttempt,
  type AccountDeletionSnapshot,
  type AccountDeletionScope,
} from './public';

const outboxUnavailableFailureCode = parseAccountDeletionFailureCode(
  'private-object-outbox-unavailable',
);
const storageUnavailableFailureCode = parseAccountDeletionFailureCode(
  'private-object-storage-unavailable',
);
const incompleteFailureCode = parseAccountDeletionFailureCode(
  'private-object-delete-incomplete',
);
const confirmationUnavailableFailureCode = parseAccountDeletionFailureCode(
  'private-object-confirmation-unavailable',
);
const ownerMismatchFailureCode = parseAccountDeletionFailureCode(
  'private-object-owner-mismatch',
);
const invalidCommandFailureCode = parseAccountDeletionFailureCode(
  'private-object-command-rejected',
);

export type DeletePrivateObjectsStepPlan =
  | {
      readonly kind: 'accepted';
      readonly scope: AccountDeletionScope;
      readonly attemptedAt: number;
      readonly attempt: AccountDeletionAttempt;
      readonly finishedAt: number;
    }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-snapshot'
        | 'wrong-state'
        | 'wrong-step'
        | 'invalid-timestamp';
    };

export type DeletePrivateObjectsEffectResult =
  | VaultPrivateObjectPurgeResult
  | { readonly kind: 'unavailable' };

export function planDeletePrivateObjectsStep(input: {
  readonly snapshot: AccountDeletionSnapshot;
  readonly executedAt: number;
}): DeletePrivateObjectsStepPlan {
  if (!isValidAccountDeletionSnapshot(input.snapshot)) {
    return { kind: 'rejected', reason: 'invalid-snapshot' };
  }
  const operation = input.snapshot.operation;
  const state = operation.state;
  if (state.kind !== 'running') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (state.step !== 'delete-private-objects') {
    return { kind: 'rejected', reason: 'wrong-step' };
  }
  if (
    !Number.isSafeInteger(input.executedAt) ||
    input.executedAt < operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  const liveDataReceipt = input.snapshot.receipts[2];
  if (
    liveDataReceipt === undefined ||
    liveDataReceipt.step !== 'delete-vault-data'
  ) {
    return { kind: 'rejected', reason: 'invalid-snapshot' };
  }
  return {
    kind: 'accepted',
    scope: {
      accountId: operation.accountId,
      vaultId: operation.vaultId,
    },
    attemptedAt: input.executedAt,
    attempt: state.attempt,
    finishedAt: input.executedAt,
  };
}

export function mapDeletePrivateObjectsStepResult(
  plan: Extract<DeletePrivateObjectsStepPlan, { kind: 'accepted' }>,
  effect: DeletePrivateObjectsEffectResult,
): AccountDeletionStepResult {
  switch (effect.kind) {
    case 'confirmed':
      return {
        kind: 'succeeded',
        step: 'delete-private-objects',
        attempt: plan.attempt,
        finishedAt: plan.finishedAt,
      };
    case 'unavailable':
      return retryableResult(plan, outboxUnavailableFailureCode);
    case 'retryable-failure':
      switch (effect.reason) {
        case 'objects-remaining':
          return retryableResult(plan, incompleteFailureCode);
        case 'storage-unavailable':
          return retryableResult(plan, storageUnavailableFailureCode);
        case 'outbox-unavailable':
          return retryableResult(plan, outboxUnavailableFailureCode);
        case 'delete-confirmation-unavailable':
          return retryableResult(plan, confirmationUnavailableFailureCode);
      }
    case 'terminal-failure':
      return {
        kind: 'terminal-failure',
        step: 'delete-private-objects',
        attempt: plan.attempt,
        finishedAt: plan.finishedAt,
        failureCode:
          effect.reason === 'owner-mismatch'
            ? ownerMismatchFailureCode
            : invalidCommandFailureCode,
      };
    default:
      return assertNever(effect, 'Unsupported private object purge result');
  }
}

function retryableResult(
  plan: Extract<DeletePrivateObjectsStepPlan, { kind: 'accepted' }>,
  failureCode: ReturnType<typeof parseAccountDeletionFailureCode>,
): AccountDeletionStepResult {
  return {
    kind: 'retryable-failure',
    step: 'delete-private-objects',
    attempt: plan.attempt,
    finishedAt: plan.finishedAt,
    failureCode,
  };
}
