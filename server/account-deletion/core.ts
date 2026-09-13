import { assertNever } from '../../lib/shared/invariant';
import {
  accountDeletionAttemptDecoder,
  accountDeletionRevisionDecoder,
  accountDeletionSteps,
  parseAccountDeletionFailureCode,
  type AccountDeletionAttempt,
  type AccountDeletionFailureCode,
  type AccountDeletionOperation,
  type AccountDeletionOperationId,
  type AccountDeletionScope,
  type AccountDeletionSnapshot,
  type AccountDeletionState,
  type AccountDeletionStep,
  type AccountDeletionStepReceipt,
  type AccountDeletionTransition,
} from './public';

export type AccountDeletionRetryPolicy = {
  readonly delaysMs: readonly number[];
};

export type AccountDeletionStartPlan =
  | { readonly kind: 'accepted'; readonly operation: AccountDeletionOperation }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-timestamp' };

export type AccountDeletionTransitionPlan =
  | {
      readonly kind: 'accepted';
      readonly transition: AccountDeletionTransition;
    }
  | { readonly kind: 'replayed'; readonly operation: AccountDeletionOperation }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'attempt-limit'
        | 'invalid-lease'
        | 'invalid-policy'
        | 'invalid-timestamp'
        | 'not-ready'
        | 'receipt-mismatch'
        | 'revision-limit'
        | 'step-mismatch'
        | 'wrong-state';
    };

export type AccountDeletionStepResult =
  | {
      readonly kind: 'succeeded';
      readonly step: AccountDeletionStep;
      readonly attempt: AccountDeletionAttempt;
      readonly finishedAt: number;
    }
  | {
      readonly kind: 'retryable-failure';
      readonly step: AccountDeletionStep;
      readonly attempt: AccountDeletionAttempt;
      readonly finishedAt: number;
      readonly failureCode: AccountDeletionFailureCode;
    }
  | {
      readonly kind: 'terminal-failure';
      readonly step: AccountDeletionStep;
      readonly attempt: AccountDeletionAttempt;
      readonly finishedAt: number;
      readonly failureCode: AccountDeletionFailureCode;
    };

const leaseExpiredFailureCode =
  parseAccountDeletionFailureCode('lease-expired');

export function planAccountDeletionStart(input: {
  readonly operationId: AccountDeletionOperationId;
  readonly scope: AccountDeletionScope;
  readonly requestedAt: number;
}): AccountDeletionStartPlan {
  if (!validTimestamp(input.requestedAt)) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  const revision = decodeRevision(1);
  const attempt = decodeAttempt(0);
  if (revision === undefined || attempt === undefined) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  return {
    kind: 'accepted',
    operation: {
      operationId: input.operationId,
      ...input.scope,
      revision,
      state: {
        kind: 'ready',
        step: accountDeletionSteps[0],
        attempt,
        notBefore: input.requestedAt,
      },
      createdAt: input.requestedAt,
      updatedAt: input.requestedAt,
    },
  };
}

export function planAccountDeletionStepClaim(input: {
  readonly operation: AccountDeletionOperation;
  readonly startedAt: number;
  readonly leaseExpiresAt: number;
}): AccountDeletionTransitionPlan {
  const state = input.operation.state;
  if (state.kind !== 'ready') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (
    !validTimestamp(input.startedAt) ||
    input.startedAt < input.operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  if (input.startedAt < state.notBefore) {
    return { kind: 'rejected', reason: 'not-ready' };
  }
  if (
    !validTimestamp(input.leaseExpiresAt) ||
    input.leaseExpiresAt <= input.startedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-lease' };
  }
  const attempt = decodeAttempt(state.attempt + 1);
  if (attempt === undefined) {
    return { kind: 'rejected', reason: 'attempt-limit' };
  }
  return advance(
    input.operation,
    {
      kind: 'running',
      step: state.step,
      attempt,
      leaseExpiresAt: input.leaseExpiresAt,
    },
    input.startedAt,
  );
}

export function planAccountDeletionStepResult(input: {
  readonly operation: AccountDeletionOperation;
  readonly result: AccountDeletionStepResult;
  readonly existingReceipt?: AccountDeletionStepReceipt;
  readonly retryPolicy: AccountDeletionRetryPolicy;
}): AccountDeletionTransitionPlan {
  const existingReceipt = input.existingReceipt;
  if (existingReceipt !== undefined) {
    if (
      existingReceipt.operationId !== input.operation.operationId ||
      existingReceipt.step !== input.result.step ||
      input.result.kind !== 'succeeded' ||
      (input.operation.state.kind === 'running' &&
        input.operation.state.step === input.result.step)
    ) {
      return { kind: 'rejected', reason: 'receipt-mismatch' };
    }
    return { kind: 'replayed', operation: input.operation };
  }

  const state = input.operation.state;
  if (state.kind !== 'running') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (
    state.step !== input.result.step ||
    state.attempt !== input.result.attempt
  ) {
    return { kind: 'rejected', reason: 'step-mismatch' };
  }
  if (
    !validTimestamp(input.result.finishedAt) ||
    input.result.finishedAt < input.operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }

  switch (input.result.kind) {
    case 'succeeded':
      return planSuccess(input.operation, state, input.result.finishedAt);
    case 'retryable-failure':
      return planFailure(
        input.operation,
        state,
        input.result.finishedAt,
        input.result.failureCode,
        input.retryPolicy,
        true,
      );
    case 'terminal-failure':
      return planFailure(
        input.operation,
        state,
        input.result.finishedAt,
        input.result.failureCode,
        input.retryPolicy,
        false,
      );
    default:
      return assertNever(input.result, 'Unsupported account deletion result');
  }
}

export function planAccountDeletionRetryResume(input: {
  readonly operation: AccountDeletionOperation;
  readonly resumedAt: number;
}): AccountDeletionTransitionPlan {
  const state = input.operation.state;
  if (state.kind !== 'retry-wait') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (
    !validTimestamp(input.resumedAt) ||
    input.resumedAt < input.operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  if (input.resumedAt < state.retryAt) {
    return { kind: 'rejected', reason: 'not-ready' };
  }
  return advance(
    input.operation,
    {
      kind: 'ready',
      step: state.step,
      attempt: state.attempt,
      notBefore: input.resumedAt,
    },
    input.resumedAt,
  );
}

export function planAccountDeletionExpiredLeaseRecovery(input: {
  readonly operation: AccountDeletionOperation;
  readonly recoveredAt: number;
  readonly retryPolicy: AccountDeletionRetryPolicy;
}): AccountDeletionTransitionPlan {
  const state = input.operation.state;
  if (state.kind !== 'running') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (
    !validTimestamp(input.recoveredAt) ||
    input.recoveredAt < input.operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  if (input.recoveredAt < state.leaseExpiresAt) {
    return { kind: 'rejected', reason: 'not-ready' };
  }
  return planFailure(
    input.operation,
    state,
    input.recoveredAt,
    leaseExpiredFailureCode,
    input.retryPolicy,
    true,
  );
}

export function isInitialAccountDeletionOperation(
  operation: AccountDeletionOperation,
): boolean {
  return (
    validOperationTimeline(operation) &&
    operation.revision === 1 &&
    operation.createdAt === operation.updatedAt &&
    operation.state.kind === 'ready' &&
    operation.state.step === accountDeletionSteps[0] &&
    operation.state.attempt === 0 &&
    operation.state.notBefore === operation.createdAt
  );
}

export function isValidAccountDeletionTransition(
  scope: AccountDeletionScope,
  transition: AccountDeletionTransition,
): boolean {
  const { current, next, receipt } = transition;
  if (
    current.accountId !== scope.accountId ||
    current.vaultId !== scope.vaultId ||
    next.accountId !== scope.accountId ||
    next.vaultId !== scope.vaultId ||
    current.operationId !== next.operationId ||
    current.createdAt !== next.createdAt ||
    next.revision !== current.revision + 1 ||
    next.updatedAt < current.updatedAt ||
    !validOperationTimeline(current) ||
    !validOperationTimeline(next)
  ) {
    return false;
  }

  const currentState = current.state;
  const nextState = next.state;
  switch (currentState.kind) {
    case 'ready':
      return (
        receipt === undefined &&
        nextState.kind === 'running' &&
        nextState.step === currentState.step &&
        nextState.attempt === currentState.attempt + 1 &&
        next.updatedAt >= currentState.notBefore &&
        nextState.leaseExpiresAt > next.updatedAt
      );
    case 'running':
      if (nextState.kind === 'retry-wait') {
        return (
          receipt === undefined &&
          sameActiveStep(currentState, nextState) &&
          nextState.retryAt >= next.updatedAt
        );
      }
      if (nextState.kind === 'terminal-failure') {
        return receipt === undefined && sameActiveStep(currentState, nextState);
      }
      if (nextState.kind === 'ready') {
        return (
          validSuccessReceipt(current, next, receipt) &&
          nextStep(currentState.step) === nextState.step &&
          nextState.attempt === 0 &&
          nextState.notBefore === next.updatedAt
        );
      }
      if (nextState.kind === 'completed') {
        return (
          currentState.step === accountDeletionSteps.at(-1) &&
          validSuccessReceipt(current, next, receipt) &&
          nextState.completedAt === next.updatedAt
        );
      }
      return false;
    case 'retry-wait':
      return (
        receipt === undefined &&
        nextState.kind === 'ready' &&
        nextState.step === currentState.step &&
        nextState.attempt === currentState.attempt &&
        nextState.notBefore === next.updatedAt &&
        next.updatedAt >= currentState.retryAt
      );
    case 'terminal-failure':
    case 'completed':
      return false;
    default:
      return assertNever(currentState, 'Unsupported account deletion state');
  }
}

export function isValidAccountDeletionSnapshot(
  snapshot: AccountDeletionSnapshot,
): boolean {
  const { operation, receipts } = snapshot;
  if (!validOperationTimeline(operation)) return false;
  let previousCompletedAt = operation.createdAt;
  for (const [index, receipt] of receipts.entries()) {
    if (
      receipt.operationId !== operation.operationId ||
      receipt.step !== accountDeletionSteps[index] ||
      receipt.completedAt < previousCompletedAt ||
      receipt.completedAt > operation.updatedAt
    ) {
      return false;
    }
    previousCompletedAt = receipt.completedAt;
  }
  if (receipts.length > accountDeletionSteps.length) return false;
  if (operation.state.kind === 'completed') {
    return receipts.length === accountDeletionSteps.length;
  }
  return operation.state.step === accountDeletionSteps[receipts.length];
}

export function sameAccountDeletionOperation(
  left: AccountDeletionOperation,
  right: AccountDeletionOperation,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.accountId === right.accountId &&
    left.vaultId === right.vaultId &&
    left.revision === right.revision &&
    left.createdAt === right.createdAt &&
    left.updatedAt === right.updatedAt &&
    sameState(left.state, right.state)
  );
}

export function sameAccountDeletionReceipt(
  left: AccountDeletionStepReceipt,
  right: AccountDeletionStepReceipt,
): boolean {
  return (
    left.operationId === right.operationId &&
    left.step === right.step &&
    left.completedAt === right.completedAt
  );
}

function planSuccess(
  operation: AccountDeletionOperation,
  state: Extract<AccountDeletionState, { kind: 'running' }>,
  completedAt: number,
): AccountDeletionTransitionPlan {
  const following = nextStep(state.step);
  const receipt: AccountDeletionStepReceipt = {
    operationId: operation.operationId,
    step: state.step,
    completedAt,
  };
  const nextState: AccountDeletionState =
    following === undefined
      ? { kind: 'completed', completedAt }
      : {
          kind: 'ready',
          step: following,
          attempt: requiredAttempt(0),
          notBefore: completedAt,
        };
  return advance(operation, nextState, completedAt, receipt);
}

function planFailure(
  operation: AccountDeletionOperation,
  state: Extract<AccountDeletionState, { kind: 'running' }>,
  failedAt: number,
  failureCode: AccountDeletionFailureCode,
  policy: AccountDeletionRetryPolicy,
  retryable: boolean,
): AccountDeletionTransitionPlan {
  if (!retryable) {
    return advance(
      operation,
      {
        kind: 'terminal-failure',
        step: state.step,
        attempt: state.attempt,
        failureCode,
      },
      failedAt,
    );
  }
  if (!validRetryPolicy(policy)) {
    return { kind: 'rejected', reason: 'invalid-policy' };
  }
  const delay = policy.delaysMs[state.attempt - 1];
  if (delay === undefined) {
    return advance(
      operation,
      {
        kind: 'terminal-failure',
        step: state.step,
        attempt: state.attempt,
        failureCode,
      },
      failedAt,
    );
  }
  const retryAt = failedAt + delay;
  if (!Number.isSafeInteger(retryAt)) {
    return { kind: 'rejected', reason: 'invalid-policy' };
  }
  return advance(
    operation,
    {
      kind: 'retry-wait',
      step: state.step,
      attempt: state.attempt,
      retryAt,
      failureCode,
    },
    failedAt,
  );
}

function advance(
  current: AccountDeletionOperation,
  state: AccountDeletionState,
  updatedAt: number,
  receipt?: AccountDeletionStepReceipt,
): AccountDeletionTransitionPlan {
  const revision = decodeRevision(current.revision + 1);
  if (revision === undefined) {
    return { kind: 'rejected', reason: 'revision-limit' };
  }
  const next: AccountDeletionOperation = {
    ...current,
    revision,
    state,
    updatedAt,
  };
  return {
    kind: 'accepted',
    transition: receipt ? { current, next, receipt } : { current, next },
  };
}

function nextStep(step: AccountDeletionStep): AccountDeletionStep | undefined {
  const index = accountDeletionSteps.indexOf(step);
  return accountDeletionSteps[index + 1];
}

function sameActiveStep(
  left: Extract<AccountDeletionState, { kind: 'running' }>,
  right: Extract<
    AccountDeletionState,
    { kind: 'retry-wait' | 'terminal-failure' }
  >,
): boolean {
  return left.step === right.step && left.attempt === right.attempt;
}

function validSuccessReceipt(
  current: AccountDeletionOperation,
  next: AccountDeletionOperation,
  receipt: AccountDeletionStepReceipt | undefined,
): boolean {
  return (
    current.state.kind === 'running' &&
    receipt !== undefined &&
    receipt.operationId === current.operationId &&
    receipt.step === current.state.step &&
    receipt.completedAt === next.updatedAt
  );
}

function validOperationTimeline(operation: AccountDeletionOperation): boolean {
  if (
    !validTimestamp(operation.createdAt) ||
    !validTimestamp(operation.updatedAt) ||
    operation.updatedAt < operation.createdAt
  ) {
    return false;
  }
  switch (operation.state.kind) {
    case 'ready':
      return (
        operation.state.notBefore >= operation.updatedAt &&
        operation.state.attempt >= 0
      );
    case 'running':
      return (
        operation.state.attempt > 0 &&
        operation.state.leaseExpiresAt > operation.updatedAt
      );
    case 'retry-wait':
      return (
        operation.state.attempt > 0 &&
        operation.state.retryAt >= operation.updatedAt
      );
    case 'terminal-failure':
      return operation.state.attempt > 0;
    case 'completed':
      return operation.state.completedAt === operation.updatedAt;
    default:
      return assertNever(operation.state, 'Unsupported deletion timeline');
  }
}

function sameState(
  left: AccountDeletionState,
  right: AccountDeletionState,
): boolean {
  if (left.kind !== right.kind) return false;
  switch (left.kind) {
    case 'ready':
      return (
        right.kind === 'ready' &&
        left.step === right.step &&
        left.attempt === right.attempt &&
        left.notBefore === right.notBefore
      );
    case 'running':
      return (
        right.kind === 'running' &&
        left.step === right.step &&
        left.attempt === right.attempt &&
        left.leaseExpiresAt === right.leaseExpiresAt
      );
    case 'retry-wait':
      return (
        right.kind === 'retry-wait' &&
        left.step === right.step &&
        left.attempt === right.attempt &&
        left.retryAt === right.retryAt &&
        left.failureCode === right.failureCode
      );
    case 'terminal-failure':
      return (
        right.kind === 'terminal-failure' &&
        left.step === right.step &&
        left.attempt === right.attempt &&
        left.failureCode === right.failureCode
      );
    case 'completed':
      return (
        right.kind === 'completed' && left.completedAt === right.completedAt
      );
    default:
      return assertNever(left, 'Unsupported account deletion state');
  }
}

function validRetryPolicy(policy: AccountDeletionRetryPolicy): boolean {
  return (
    policy.delaysMs.length <= 10 &&
    policy.delaysMs.every((delay) => Number.isSafeInteger(delay) && delay >= 0)
  );
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function decodeRevision(value: number) {
  const decoded = accountDeletionRevisionDecoder.decode(value);
  return decoded.ok ? decoded.value : undefined;
}

function decodeAttempt(value: number) {
  const decoded = accountDeletionAttemptDecoder.decode(value);
  return decoded.ok ? decoded.value : undefined;
}

function requiredAttempt(value: number): AccountDeletionAttempt {
  const decoded = decodeAttempt(value);
  if (decoded === undefined) {
    throw new Error('Account deletion attempt constant is invalid');
  }
  return decoded;
}
