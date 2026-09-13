import type {
  AccountId,
  VaultContext,
  VaultId,
} from '../../lib/domain/identity';
import {
  sessionRecordDecoder,
  type ActiveSession,
  type RevokedSession,
} from '../core/session';
import type {
  AccountRecord,
  IdentityRecord,
  PersonalVaultRecord,
  SessionTokenHash,
} from './records';

export type PersonalAccountProvision = {
  readonly account: AccountRecord;
  readonly vault: PersonalVaultRecord;
  readonly identity: IdentityRecord;
};

export type AccountSessionRevocationCommand = {
  readonly accountId: AccountId;
  readonly vaultId: VaultId;
  readonly revokedAt: number;
};

export type AccountSessionRevocationResult =
  | { readonly kind: 'applied'; readonly revokedSessionCount: number }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-revocation-time'
        | 'invalid-result'
        | 'owner-mismatch'
        | 'incomplete-revocation';
    };

export type AccountLiveStateFinalizationResult =
  | {
      readonly kind: 'confirmed';
      readonly outcome: 'deleted' | 'already-finalized';
    }
  | {
      readonly kind: 'retryable-failure';
      readonly reason: 'incomplete-finalization' | 'invalid-result';
    }
  | {
      readonly kind: 'terminal-failure';
      readonly reason: 'owner-mismatch';
    };

export type AccountLiveStateCounts = {
  readonly ownerCount: number;
  readonly accountCount: number;
  readonly vaultCount: number;
  readonly identityCount: number;
  readonly sessionCount: number;
};

export type AccountSessionRevocationPlan =
  | {
      readonly kind: 'accepted';
      readonly command: AccountSessionRevocationCommand;
    }
  | {
      readonly kind: 'rejected';
      readonly reason: 'invalid-revocation-time';
    };

export function planAccountSessionRevocation(
  command: AccountSessionRevocationCommand,
): AccountSessionRevocationPlan {
  return Number.isSafeInteger(command.revokedAt) && command.revokedAt >= 0
    ? { kind: 'accepted', command }
    : { kind: 'rejected', reason: 'invalid-revocation-time' };
}

export function evaluateAccountSessionRevocation(input: {
  readonly ownerCount: number;
  readonly revokedSessionCount: number;
  readonly remainingActiveSessionCount: number;
}): AccountSessionRevocationResult {
  if (
    !validCount(input.ownerCount) ||
    !validCount(input.revokedSessionCount) ||
    !validCount(input.remainingActiveSessionCount) ||
    input.ownerCount > 1
  ) {
    return { kind: 'rejected', reason: 'invalid-result' };
  }
  if (input.ownerCount !== 1) {
    return { kind: 'rejected', reason: 'owner-mismatch' };
  }
  if (input.remainingActiveSessionCount !== 0) {
    return { kind: 'rejected', reason: 'incomplete-revocation' };
  }
  return {
    kind: 'applied',
    revokedSessionCount: input.revokedSessionCount,
  };
}

export function evaluateAccountLiveStateFinalization(input: {
  readonly before: AccountLiveStateCounts;
  readonly deletedAccountCount: number;
  readonly after: AccountLiveStateCounts;
}): AccountLiveStateFinalizationResult {
  const counts = [
    ...stateCounts(input.before),
    input.deletedAccountCount,
    ...stateCounts(input.after),
  ];
  if (counts.some((count) => !validCount(count))) {
    return { kind: 'retryable-failure', reason: 'invalid-result' };
  }
  if (
    input.before.ownerCount > 1 ||
    input.before.accountCount > 1 ||
    input.before.vaultCount > 1 ||
    input.after.ownerCount > 1 ||
    input.after.accountCount > 1 ||
    input.after.vaultCount > 1 ||
    input.deletedAccountCount > 1
  ) {
    return { kind: 'retryable-failure', reason: 'invalid-result' };
  }
  if (input.before.ownerCount === 0) {
    return stateIsEmpty(input.before) &&
      input.deletedAccountCount === 0 &&
      stateIsEmpty(input.after)
      ? { kind: 'confirmed', outcome: 'already-finalized' }
      : { kind: 'terminal-failure', reason: 'owner-mismatch' };
  }
  if (input.before.accountCount !== 1 || input.before.vaultCount !== 1) {
    return { kind: 'terminal-failure', reason: 'owner-mismatch' };
  }
  if (input.deletedAccountCount !== 1 || !stateIsEmpty(input.after)) {
    return { kind: 'retryable-failure', reason: 'incomplete-finalization' };
  }
  return { kind: 'confirmed', outcome: 'deleted' };
}

export type OwnershipPlan =
  | { readonly kind: 'accepted' }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'account-mismatch'
        | 'vault-mismatch'
        | 'created-at-mismatch'
        | 'invalid-session'
        | 'session-mismatch';
    };

export function planPersonalAccountProvision(
  provision: PersonalAccountProvision,
): OwnershipPlan {
  if (
    provision.vault.accountId !== provision.account.accountId ||
    provision.identity.accountId !== provision.account.accountId
  ) {
    return { kind: 'rejected', reason: 'account-mismatch' };
  }
  return provision.vault.createdAt === provision.account.createdAt &&
    provision.identity.createdAt === provision.account.createdAt
    ? { kind: 'accepted' }
    : { kind: 'rejected', reason: 'created-at-mismatch' };
}

export function planIdentityLink(
  context: VaultContext,
  identity: IdentityRecord,
): OwnershipPlan {
  return context.accountId === identity.accountId
    ? { kind: 'accepted' }
    : { kind: 'rejected', reason: 'account-mismatch' };
}

export function planSessionStorage(input: {
  readonly accountId: AccountRecord['accountId'];
  readonly vaultId: PersonalVaultRecord['vaultId'];
  readonly session: ActiveSession;
  readonly tokenHash: SessionTokenHash;
}): OwnershipPlan {
  if (input.session.accountId !== input.accountId) {
    return { kind: 'rejected', reason: 'account-mismatch' };
  }
  if (input.session.vaultId !== input.vaultId) {
    return { kind: 'rejected', reason: 'vault-mismatch' };
  }
  return sessionRecordDecoder.decode(input.session).ok
    ? { kind: 'accepted' }
    : { kind: 'rejected', reason: 'invalid-session' };
}

export function planSessionRevocation(
  context: VaultContext,
  session: RevokedSession,
): OwnershipPlan {
  if (
    context.sessionId !== session.sessionId ||
    context.sessionEpoch !== session.sessionEpoch
  ) {
    return { kind: 'rejected', reason: 'session-mismatch' };
  }
  if (context.accountId !== session.accountId) {
    return { kind: 'rejected', reason: 'account-mismatch' };
  }
  return context.vaultId === session.vaultId
    ? { kind: 'accepted' }
    : { kind: 'rejected', reason: 'vault-mismatch' };
}

function validCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function stateCounts(value: AccountLiveStateCounts): readonly number[] {
  return [
    value.ownerCount,
    value.accountCount,
    value.vaultCount,
    value.identityCount,
    value.sessionCount,
  ];
}

function stateIsEmpty(value: AccountLiveStateCounts): boolean {
  return stateCounts(value).every((count) => count === 0);
}
