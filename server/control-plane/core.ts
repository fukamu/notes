import type { VaultContext } from '../../lib/domain/identity';
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
