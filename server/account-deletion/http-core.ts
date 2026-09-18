import { assertNever } from '../../lib/shared/invariant';
import {
  isInitialAccountDeletionOperation,
  planAccountDeletionExpiredLeaseRecovery,
  planAccountDeletionRetryResume,
  planAccountDeletionStepClaim,
  type AccountDeletionRetryPolicy,
} from './core';
import {
  accountDeletionContinuationSequenceDecoder,
  type AccountDeletionContinuation,
  type AccountDeletionContinuationSequence,
  type AccountDeletionCredentialHash,
  type AccountDeletionOperation,
  type AccountDeletionPublicStatus,
  type AccountDeletionSnapshot,
  type AccountDeletionTransition,
} from './public';

export type AccountDeletionContinuationStartPlan =
  | {
      readonly kind: 'accepted';
      readonly continuation: AccountDeletionContinuation;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'invalid-expiry' | 'invalid-operation';
    };

export type AccountDeletionContinuationConsumePlan =
  | {
      readonly kind: 'consume';
      readonly next: AccountDeletionContinuation;
    }
  | { readonly kind: 'replay' }
  | {
      readonly kind: 'rejected';
      readonly reason: 'expired' | 'invalid-capability' | 'invalid-timestamp';
    };

export type AccountDeletionRunPlan =
  | { readonly kind: 'report' }
  | {
      readonly kind: 'claim-step';
      readonly transition: AccountDeletionTransition;
    }
  | {
      readonly kind: 'advance-state';
      readonly transition: AccountDeletionTransition;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'invalid-policy' | 'invalid-state' | 'invalid-timestamp';
    };

export function planAccountDeletionContinuationStart(input: {
  readonly operation: AccountDeletionOperation;
  readonly idempotencyKeyHash: AccountDeletionCredentialHash;
  readonly secretHash: AccountDeletionCredentialHash;
  readonly expiresAt: number;
}): AccountDeletionContinuationStartPlan {
  if (!isInitialAccountDeletionOperation(input.operation)) {
    return { kind: 'rejected', reason: 'invalid-operation' };
  }
  if (
    !validTimestamp(input.expiresAt) ||
    input.expiresAt <= input.operation.createdAt
  ) {
    return { kind: 'rejected', reason: 'invalid-expiry' };
  }
  const sequence = decodeContinuationSequence(0);
  if (sequence === undefined) {
    return { kind: 'rejected', reason: 'invalid-operation' };
  }
  return {
    kind: 'accepted',
    continuation: {
      operationId: input.operation.operationId,
      idempotencyKeyHash: input.idempotencyKeyHash,
      secretHash: input.secretHash,
      sequence,
      expiresAt: input.expiresAt,
      createdAt: input.operation.createdAt,
      updatedAt: input.operation.createdAt,
    },
  };
}

export function planAccountDeletionContinuationConsume(input: {
  readonly continuation: AccountDeletionContinuation;
  readonly presentedSequence: AccountDeletionContinuationSequence;
  readonly consumedAt: number;
}): AccountDeletionContinuationConsumePlan {
  if (!validTimestamp(input.consumedAt)) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  if (!isValidAccountDeletionContinuation(input.continuation)) {
    return { kind: 'rejected', reason: 'invalid-capability' };
  }
  if (input.consumedAt >= input.continuation.expiresAt) {
    return { kind: 'rejected', reason: 'expired' };
  }
  if (input.presentedSequence === input.continuation.sequence - 1) {
    return { kind: 'replay' };
  }
  if (input.presentedSequence !== input.continuation.sequence) {
    return { kind: 'rejected', reason: 'invalid-capability' };
  }
  const sequence = decodeContinuationSequence(input.continuation.sequence + 1);
  if (sequence === undefined) {
    return { kind: 'rejected', reason: 'invalid-capability' };
  }
  return {
    kind: 'consume',
    next: {
      ...input.continuation,
      sequence,
      updatedAt: input.consumedAt,
    },
  };
}

export function isValidAccountDeletionContinuation(
  continuation: AccountDeletionContinuation,
): boolean {
  return (
    continuation.expiresAt > continuation.createdAt &&
    continuation.updatedAt >= continuation.createdAt &&
    continuation.updatedAt < continuation.expiresAt
  );
}

export function planAccountDeletionRun(input: {
  readonly snapshot: AccountDeletionSnapshot;
  readonly now: number;
  readonly leaseDurationMs: number;
  readonly retryPolicy: AccountDeletionRetryPolicy;
}): AccountDeletionRunPlan {
  if (!validTimestamp(input.now)) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  const operation = input.snapshot.operation;
  switch (operation.state.kind) {
    case 'completed':
    case 'terminal-failure':
      return { kind: 'report' };
    case 'ready': {
      if (input.now < operation.state.notBefore) return { kind: 'report' };
      if (
        !Number.isSafeInteger(input.leaseDurationMs) ||
        input.leaseDurationMs <= 0
      ) {
        return { kind: 'rejected', reason: 'invalid-policy' };
      }
      const leaseExpiresAt = input.now + input.leaseDurationMs;
      if (!Number.isSafeInteger(leaseExpiresAt)) {
        return { kind: 'rejected', reason: 'invalid-policy' };
      }
      const plan = planAccountDeletionStepClaim({
        operation,
        startedAt: input.now,
        leaseExpiresAt,
      });
      return plan.kind === 'accepted'
        ? { kind: 'claim-step', transition: plan.transition }
        : { kind: 'rejected', reason: 'invalid-state' };
    }
    case 'retry-wait': {
      if (input.now < operation.state.retryAt) return { kind: 'report' };
      const plan = planAccountDeletionRetryResume({
        operation,
        resumedAt: input.now,
      });
      return plan.kind === 'accepted'
        ? { kind: 'advance-state', transition: plan.transition }
        : { kind: 'rejected', reason: 'invalid-state' };
    }
    case 'running': {
      if (input.now < operation.state.leaseExpiresAt) {
        return { kind: 'report' };
      }
      const plan = planAccountDeletionExpiredLeaseRecovery({
        operation,
        recoveredAt: input.now,
        retryPolicy: input.retryPolicy,
      });
      return plan.kind === 'accepted'
        ? { kind: 'advance-state', transition: plan.transition }
        : { kind: 'rejected', reason: 'invalid-state' };
    }
    default:
      return assertNever(operation.state, 'Unsupported deletion run state');
  }
}

export function accountDeletionPublicStatus(
  snapshot: AccountDeletionSnapshot,
): AccountDeletionPublicStatus {
  switch (snapshot.operation.state.kind) {
    case 'ready':
    case 'running':
      return { kind: 'in-progress' };
    case 'retry-wait':
      return {
        kind: 'retry-wait',
        retryAt: snapshot.operation.state.retryAt,
      };
    case 'terminal-failure':
      return { kind: 'failed' };
    case 'completed':
      return { kind: 'completed' };
    default:
      return assertNever(
        snapshot.operation.state,
        'Unsupported deletion public status',
      );
  }
}

function decodeContinuationSequence(
  value: number,
): AccountDeletionContinuationSequence | undefined {
  const decoded = accountDeletionContinuationSequenceDecoder.decode(value);
  return decoded.ok ? decoded.value : undefined;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
