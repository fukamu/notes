import { assertNever } from '../../lib/shared/invariant';
import type { AccountLiveStateFinalizationResult } from '../control-plane/public';
import type { VaultWrappedKeyFinalizationResult } from '../crypto/public';
import type { VaultPrivateObjectDeletionBarrierResult } from '../encrypted-object/public';
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

const wrappedKeysUnavailableFailureCode = parseAccountDeletionFailureCode(
  'wrapped-key-finalization-unavailable',
);
const privateObjectsUnavailableFailureCode = parseAccountDeletionFailureCode(
  'private-object-reconfirmation-unavailable',
);
const privateObjectsIncompleteFailureCode = parseAccountDeletionFailureCode(
  'private-object-reconfirmation-incomplete',
);
const privateObjectsRejectedFailureCode = parseAccountDeletionFailureCode(
  'private-object-reconfirmation-rejected',
);
const wrappedKeysIncompleteFailureCode = parseAccountDeletionFailureCode(
  'wrapped-key-finalization-incomplete',
);
const wrappedKeysOwnerMismatchFailureCode = parseAccountDeletionFailureCode(
  'wrapped-key-owner-mismatch',
);
const liveStateUnavailableFailureCode = parseAccountDeletionFailureCode(
  'account-live-state-unavailable',
);
const liveStateIncompleteFailureCode = parseAccountDeletionFailureCode(
  'account-live-state-incomplete',
);
const liveStateOwnerMismatchFailureCode = parseAccountDeletionFailureCode(
  'account-live-owner-mismatch',
);

export type FinalizeAccountStepPlan =
  | {
      readonly kind: 'accepted';
      readonly scope: AccountDeletionScope;
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

export type WrappedKeyFinalizationEffect =
  | VaultWrappedKeyFinalizationResult
  | { readonly kind: 'unavailable' };

export type PrivateObjectReconfirmationEffect =
  | VaultPrivateObjectDeletionBarrierResult
  | { readonly kind: 'unavailable' };

export type AccountLiveStateFinalizationEffect =
  | AccountLiveStateFinalizationResult
  | { readonly kind: 'unavailable' };

export type WrappedKeyFinalizationDecision =
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'complete';
      readonly result: AccountDeletionStepResult;
    };

export type PrivateObjectReconfirmationDecision =
  | { readonly kind: 'continue' }
  | {
      readonly kind: 'complete';
      readonly result: AccountDeletionStepResult;
    };

export function planFinalizeAccountStep(input: {
  readonly snapshot: AccountDeletionSnapshot;
  readonly executedAt: number;
}): FinalizeAccountStepPlan {
  if (!isValidAccountDeletionSnapshot(input.snapshot)) {
    return { kind: 'rejected', reason: 'invalid-snapshot' };
  }
  const operation = input.snapshot.operation;
  const state = operation.state;
  if (state.kind !== 'running') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (state.step !== 'finalize-account') {
    return { kind: 'rejected', reason: 'wrong-step' };
  }
  if (
    !Number.isSafeInteger(input.executedAt) ||
    input.executedAt < operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  const privateObjectReceipt = input.snapshot.receipts[3];
  if (
    privateObjectReceipt === undefined ||
    privateObjectReceipt.step !== 'delete-private-objects'
  ) {
    return { kind: 'rejected', reason: 'invalid-snapshot' };
  }
  return {
    kind: 'accepted',
    scope: {
      accountId: operation.accountId,
      vaultId: operation.vaultId,
    },
    attempt: state.attempt,
    finishedAt: input.executedAt,
  };
}

export function evaluateWrappedKeyFinalization(
  plan: Extract<FinalizeAccountStepPlan, { kind: 'accepted' }>,
  effect: WrappedKeyFinalizationEffect,
): WrappedKeyFinalizationDecision {
  switch (effect.kind) {
    case 'confirmed':
      return { kind: 'continue' };
    case 'unavailable':
      return {
        kind: 'complete',
        result: retryableResult(plan, wrappedKeysUnavailableFailureCode),
      };
    case 'retryable-failure':
      return {
        kind: 'complete',
        result: retryableResult(plan, wrappedKeysIncompleteFailureCode),
      };
    case 'terminal-failure':
      return {
        kind: 'complete',
        result: terminalResult(plan, wrappedKeysOwnerMismatchFailureCode),
      };
    default:
      return assertNever(effect, 'Unsupported wrapped key finalization result');
  }
}

export function evaluatePrivateObjectReconfirmation(
  plan: Extract<FinalizeAccountStepPlan, { kind: 'accepted' }>,
  effect: PrivateObjectReconfirmationEffect,
): PrivateObjectReconfirmationDecision {
  switch (effect.kind) {
    case 'confirmed':
      return { kind: 'continue' };
    case 'unavailable':
      return {
        kind: 'complete',
        result: retryableResult(plan, privateObjectsUnavailableFailureCode),
      };
    case 'retryable-failure':
      return {
        kind: 'complete',
        result: retryableResult(plan, privateObjectsIncompleteFailureCode),
      };
    case 'terminal-failure':
      return {
        kind: 'complete',
        result: terminalResult(plan, privateObjectsRejectedFailureCode),
      };
    default:
      return assertNever(
        effect,
        'Unsupported private object reconfirmation result',
      );
  }
}

export function evaluateAccountLiveStateFinalization(
  plan: Extract<FinalizeAccountStepPlan, { kind: 'accepted' }>,
  effect: AccountLiveStateFinalizationEffect,
): AccountDeletionStepResult {
  switch (effect.kind) {
    case 'confirmed':
      return {
        kind: 'succeeded',
        step: 'finalize-account',
        attempt: plan.attempt,
        finishedAt: plan.finishedAt,
      };
    case 'unavailable':
      return retryableResult(plan, liveStateUnavailableFailureCode);
    case 'retryable-failure':
      return retryableResult(plan, liveStateIncompleteFailureCode);
    case 'terminal-failure':
      return terminalResult(plan, liveStateOwnerMismatchFailureCode);
    default:
      return assertNever(effect, 'Unsupported Account finalization result');
  }
}

function retryableResult(
  plan: Extract<FinalizeAccountStepPlan, { kind: 'accepted' }>,
  failureCode: ReturnType<typeof parseAccountDeletionFailureCode>,
): AccountDeletionStepResult {
  return {
    kind: 'retryable-failure',
    step: 'finalize-account',
    attempt: plan.attempt,
    finishedAt: plan.finishedAt,
    failureCode,
  };
}

function terminalResult(
  plan: Extract<FinalizeAccountStepPlan, { kind: 'accepted' }>,
  failureCode: ReturnType<typeof parseAccountDeletionFailureCode>,
): AccountDeletionStepResult {
  return {
    kind: 'terminal-failure',
    step: 'finalize-account',
    attempt: plan.attempt,
    finishedAt: plan.finishedAt,
    failureCode,
  };
}
