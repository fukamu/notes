import { assertNever } from '../../lib/shared/invariant';
import type {
  AccountSessionRevocationCommand,
  AccountSessionRevocationPort,
  AccountSessionRevocationResult,
} from '../control-plane/public';
import type { AccountDeletionStepResult } from './core';
import {
  parseAccountDeletionFailureCode,
  type AccountDeletionAttempt,
  type AccountDeletionOperation,
} from './public';

const unavailableFailureCode = parseAccountDeletionFailureCode(
  'session-revocation-unavailable',
);
const incompleteFailureCode = parseAccountDeletionFailureCode(
  'session-revocation-incomplete',
);
const ownerMismatchFailureCode = parseAccountDeletionFailureCode(
  'session-owner-mismatch',
);
const contractFailureCode = parseAccountDeletionFailureCode(
  'session-revocation-contract-rejected',
);

export type RevokeSessionsStepPlan =
  | {
      readonly kind: 'accepted';
      readonly command: AccountSessionRevocationCommand;
      readonly attempt: AccountDeletionAttempt;
      readonly finishedAt: number;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'wrong-state' | 'wrong-step' | 'invalid-timestamp';
    };

export type RevokeSessionsEffectResult =
  | AccountSessionRevocationResult
  | { readonly kind: 'unavailable' };

export type RevokeSessionsExecutionResult =
  | Extract<RevokeSessionsStepPlan, { kind: 'rejected' }>
  | {
      readonly kind: 'executed';
      readonly result: AccountDeletionStepResult;
    };

export function planRevokeSessionsStep(input: {
  readonly operation: AccountDeletionOperation;
  readonly revokedAt: number;
}): RevokeSessionsStepPlan {
  const state = input.operation.state;
  if (state.kind !== 'running') {
    return { kind: 'rejected', reason: 'wrong-state' };
  }
  if (state.step !== 'revoke-sessions') {
    return { kind: 'rejected', reason: 'wrong-step' };
  }
  if (
    !Number.isSafeInteger(input.revokedAt) ||
    input.revokedAt < input.operation.updatedAt
  ) {
    return { kind: 'rejected', reason: 'invalid-timestamp' };
  }
  return {
    kind: 'accepted',
    command: {
      accountId: input.operation.accountId,
      vaultId: input.operation.vaultId,
      revokedAt: input.revokedAt,
    },
    attempt: state.attempt,
    finishedAt: input.revokedAt,
  };
}

export function mapRevokeSessionsStepResult(
  plan: Extract<RevokeSessionsStepPlan, { kind: 'accepted' }>,
  effect: RevokeSessionsEffectResult,
): AccountDeletionStepResult {
  if (effect.kind === 'applied') {
    return {
      kind: 'succeeded',
      step: 'revoke-sessions',
      attempt: plan.attempt,
      finishedAt: plan.finishedAt,
    };
  }
  if (effect.kind === 'unavailable') {
    return {
      kind: 'retryable-failure',
      step: 'revoke-sessions',
      attempt: plan.attempt,
      finishedAt: plan.finishedAt,
      failureCode: unavailableFailureCode,
    };
  }
  switch (effect.reason) {
    case 'owner-mismatch':
      return {
        kind: 'terminal-failure',
        step: 'revoke-sessions',
        attempt: plan.attempt,
        finishedAt: plan.finishedAt,
        failureCode: ownerMismatchFailureCode,
      };
    case 'incomplete-revocation':
    case 'invalid-result':
      return {
        kind: 'retryable-failure',
        step: 'revoke-sessions',
        attempt: plan.attempt,
        finishedAt: plan.finishedAt,
        failureCode: incompleteFailureCode,
      };
    case 'invalid-revocation-time':
      return {
        kind: 'terminal-failure',
        step: 'revoke-sessions',
        attempt: plan.attempt,
        finishedAt: plan.finishedAt,
        failureCode: contractFailureCode,
      };
    default:
      return assertNever(
        effect.reason,
        'Unsupported account session revocation result',
      );
  }
}

export async function executeRevokeSessionsStep(input: {
  readonly operation: AccountDeletionOperation;
  readonly revokedAt: number;
  readonly sessions: AccountSessionRevocationPort;
}): Promise<RevokeSessionsExecutionResult> {
  const plan = planRevokeSessionsStep(input);
  if (plan.kind === 'rejected') return plan;

  let effect: RevokeSessionsEffectResult;
  try {
    effect = await input.sessions.revokeAccountSessions(plan.command);
  } catch {
    effect = { kind: 'unavailable' };
  }
  return {
    kind: 'executed',
    result: mapRevokeSessionsStepResult(plan, effect),
  };
}
