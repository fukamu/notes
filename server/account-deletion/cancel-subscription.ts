import type { SubscriptionCancellationPort } from '../billing/public';
import { subscriptionCancellationIdempotencyKeyDecoder } from '../billing/public';
import type { SubscriptionCancellationResult } from '../billing/public';
import {
  isValidAccountDeletionSnapshot,
  type AccountDeletionStepResult,
} from './core';
import {
  parseAccountDeletionFailureCode,
  type AccountDeletionAttempt,
  type AccountDeletionSnapshot,
} from './public';

const unavailableFailureCode = parseAccountDeletionFailureCode(
  'subscription-cancellation-unavailable',
);
const incompleteFailureCode = parseAccountDeletionFailureCode(
  'subscription-cancellation-incomplete',
);
const ownerMismatchFailureCode = parseAccountDeletionFailureCode(
  'subscription-owner-mismatch',
);
const terminalFailureCode = parseAccountDeletionFailureCode(
  'subscription-cancellation-terminal',
);

export type CancelSubscriptionStepPlan =
  | {
      readonly kind: 'accepted';
      readonly command: Parameters<
        SubscriptionCancellationPort['cancelSubscription']
      >[0];
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

export type CancelSubscriptionExecutionResult =
  | Extract<CancelSubscriptionStepPlan, { kind: 'rejected' }>
  | {
      readonly kind: 'executed';
      readonly result: AccountDeletionStepResult;
    };

export function planCancelSubscriptionStep(input: {
  readonly snapshot: AccountDeletionSnapshot;
  readonly executedAt: number;
}): CancelSubscriptionStepPlan {
  if (!isValidAccountDeletionSnapshot(input.snapshot)) {
    return { kind: 'rejected', reason: 'invalid-snapshot' };
  }
  const operation = input.snapshot.operation;
  const state = operation.state;
  if (state.kind !== 'running') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (state.step !== 'cancel-subscription') {
    return { kind: 'rejected', reason: 'wrong-step' };
  }
  if (
    !Number.isSafeInteger(input.executedAt) ||
    input.executedAt < operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  const revokeSessionsReceipt = input.snapshot.receipts[0];
  if (
    revokeSessionsReceipt === undefined ||
    revokeSessionsReceipt.step !== 'revoke-sessions'
  ) {
    return { kind: 'rejected', reason: 'invalid-snapshot' };
  }
  const idempotencyKey = subscriptionCancellationIdempotencyKeyDecoder.decode(
    operation.operationId,
  );
  if (!idempotencyKey.ok) {
    return { kind: 'rejected', reason: 'invalid-snapshot' };
  }
  return {
    kind: 'accepted',
    command: {
      accountId: operation.accountId,
      vaultId: operation.vaultId,
      idempotencyKey: idempotencyKey.value,
      requestedAt: revokeSessionsReceipt.completedAt,
    },
    attempt: state.attempt,
    finishedAt: input.executedAt,
  };
}

export function mapCancelSubscriptionStepResult(
  plan: Extract<CancelSubscriptionStepPlan, { kind: 'accepted' }>,
  cancellation:
    | SubscriptionCancellationResult
    | { readonly kind: 'unavailable' },
): AccountDeletionStepResult {
  if (cancellation.kind === 'confirmed') {
    return {
      kind: 'succeeded',
      step: 'cancel-subscription',
      attempt: plan.attempt,
      finishedAt: plan.finishedAt,
    };
  }
  if (cancellation.kind === 'unavailable') {
    return retryableResult(plan, unavailableFailureCode);
  }
  if (cancellation.kind === 'retryable-failure') {
    return retryableResult(plan, incompleteFailureCode);
  }
  return {
    kind: 'terminal-failure',
    step: 'cancel-subscription',
    attempt: plan.attempt,
    finishedAt: plan.finishedAt,
    failureCode:
      cancellation.reason === 'owner-mismatch'
        ? ownerMismatchFailureCode
        : terminalFailureCode,
  };
}

export async function executeCancelSubscriptionStep(input: {
  readonly snapshot: AccountDeletionSnapshot;
  readonly executedAt: number;
  readonly billing: SubscriptionCancellationPort;
}): Promise<CancelSubscriptionExecutionResult> {
  const plan = planCancelSubscriptionStep(input);
  if (plan.kind === 'rejected') return plan;

  let cancellation:
    | SubscriptionCancellationResult
    | { readonly kind: 'unavailable' };
  try {
    cancellation = await input.billing.cancelSubscription(plan.command);
  } catch {
    cancellation = { kind: 'unavailable' };
  }
  return {
    kind: 'executed',
    result: mapCancelSubscriptionStepResult(plan, cancellation),
  };
}

function retryableResult(
  plan: Extract<CancelSubscriptionStepPlan, { kind: 'accepted' }>,
  failureCode: ReturnType<typeof parseAccountDeletionFailureCode>,
): AccountDeletionStepResult {
  return {
    kind: 'retryable-failure',
    step: 'cancel-subscription',
    attempt: plan.attempt,
    finishedAt: plan.finishedAt,
    failureCode,
  };
}
