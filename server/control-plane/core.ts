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
