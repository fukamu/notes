import type {
  EncryptedObjectMetadataPurgeResult,
  EncryptedObjectMetadataPurgeScope,
} from '../encrypted-object/public';
import type { VaultLiveDataPurgeResult } from '../vault-content/public';
import {
  isValidAccountDeletionSnapshot,
  type AccountDeletionStepResult,
} from './core';
import {
  parseAccountDeletionFailureCode,
  type AccountDeletionAttempt,
  type AccountDeletionSnapshot,
} from './public';

const metadataUnavailableFailureCode = parseAccountDeletionFailureCode(
  'encrypted-object-inventory-unavailable',
);
const metadataIncompleteFailureCode = parseAccountDeletionFailureCode(
  'encrypted-object-inventory-incomplete',
);
const liveDataUnavailableFailureCode = parseAccountDeletionFailureCode(
  'vault-live-data-unavailable',
);
const liveDataIncompleteFailureCode = parseAccountDeletionFailureCode(
  'vault-live-data-incomplete',
);
const ownerMismatchFailureCode = parseAccountDeletionFailureCode(
  'vault-owner-mismatch',
);

export type DeleteVaultDataStepPlan =
  | {
      readonly kind: 'accepted';
      readonly scope: EncryptedObjectMetadataPurgeScope;
      readonly requestedAt: number;
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

export type EncryptedMetadataPurgeDecision =
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'complete';
      readonly result: AccountDeletionStepResult;
    };

export function planDeleteVaultDataStep(input: {
  readonly snapshot: AccountDeletionSnapshot;
  readonly executedAt: number;
}): DeleteVaultDataStepPlan {
  if (!isValidAccountDeletionSnapshot(input.snapshot)) {
    return { kind: 'rejected', reason: 'invalid-snapshot' };
  }
  const operation = input.snapshot.operation;
  const state = operation.state;
  if (state.kind !== 'running') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (state.step !== 'delete-vault-data') {
    return { kind: 'rejected', reason: 'wrong-step' };
  }
  if (
    !Number.isSafeInteger(input.executedAt) ||
    input.executedAt < operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  const cancellationReceipt = input.snapshot.receipts[1];
  if (
    cancellationReceipt === undefined ||
    cancellationReceipt.step !== 'cancel-subscription'
  ) {
    return { kind: 'rejected', reason: 'invalid-snapshot' };
  }
  return {
    kind: 'accepted',
    scope: {
      accountId: operation.accountId,
      vaultId: operation.vaultId,
    },
    requestedAt: cancellationReceipt.completedAt,
    attempt: state.attempt,
    finishedAt: input.executedAt,
  };
}

export function evaluateEncryptedMetadataPurge(
  plan: Extract<DeleteVaultDataStepPlan, { kind: 'accepted' }>,
  result: EncryptedObjectMetadataPurgeResult | { readonly kind: 'unavailable' },
): EncryptedMetadataPurgeDecision {
  switch (result.kind) {
    case 'confirmed':
    case 'route-not-found':
      return { kind: 'continue' };
    case 'unavailable':
      return {
        kind: 'complete',
        result: retryableResult(plan, metadataUnavailableFailureCode),
      };
    case 'retryable-failure':
      return {
        kind: 'complete',
        result: retryableResult(plan, metadataIncompleteFailureCode),
      };
  }
}

export function evaluateVaultLiveDataDelete(
  plan: Extract<DeleteVaultDataStepPlan, { kind: 'accepted' }>,
  result: VaultLiveDataPurgeResult | { readonly kind: 'unavailable' },
): AccountDeletionStepResult {
  switch (result.kind) {
    case 'confirmed':
      return {
        kind: 'succeeded',
        step: 'delete-vault-data',
        attempt: plan.attempt,
        finishedAt: plan.finishedAt,
      };
    case 'unavailable':
      return retryableResult(plan, liveDataUnavailableFailureCode);
    case 'retryable-failure':
      return retryableResult(plan, liveDataIncompleteFailureCode);
    case 'terminal-failure':
      return {
        kind: 'terminal-failure',
        step: 'delete-vault-data',
        attempt: plan.attempt,
        finishedAt: plan.finishedAt,
        failureCode: ownerMismatchFailureCode,
      };
  }
}

function retryableResult(
  plan: Extract<DeleteVaultDataStepPlan, { kind: 'accepted' }>,
  failureCode: ReturnType<typeof parseAccountDeletionFailureCode>,
): AccountDeletionStepResult {
  return {
    kind: 'retryable-failure',
    step: 'delete-vault-data',
    attempt: plan.attempt,
    finishedAt: plan.finishedAt,
    failureCode,
  };
}
