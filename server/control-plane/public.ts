import type { AccountId, VaultContext } from '../../lib/domain/identity';
import type { ActiveSession, RevokedSession } from '../core/session';
import type {
  AccountSessionRevocationCommand,
  AccountSessionRevocationResult,
  OwnershipPlan,
  PersonalAccountProvision,
} from './core';
import type {
  AccountRecord,
  IdentityProvider,
  IdentityRecord,
  PersonalVaultRecord,
  SessionTokenHash,
  StoredSessionRecord,
} from './records';

export type PersonalAccount = {
  readonly account: AccountRecord;
  readonly vault: PersonalVaultRecord;
};

export type IdentityLookup = {
  readonly provider: IdentityProvider;
  readonly issuer: string;
  readonly subject: string;
};

export type ControlPlaneCommandResult =
  | { readonly kind: 'applied' }
  | Extract<OwnershipPlan, { kind: 'rejected' }>;

export type {
  AccountSessionRevocationCommand,
  AccountSessionRevocationResult,
} from './core';

export type AccountSessionRevocationPort = {
  revokeAccountSessions(
    command: AccountSessionRevocationCommand,
  ): Promise<AccountSessionRevocationResult>;
};

export type IdentityVaultControlPlane = AccountSessionRevocationPort & {
  findPersonalAccount(
    accountId: AccountId,
  ): Promise<PersonalAccount | undefined>;
  findIdentity(lookup: IdentityLookup): Promise<IdentityRecord | undefined>;
  findSessionByTokenHash(
    tokenHash: SessionTokenHash,
  ): Promise<StoredSessionRecord | undefined>;
  provisionPersonalAccount(
    provision: PersonalAccountProvision,
  ): Promise<ControlPlaneCommandResult>;
  linkIdentity(
    context: VaultContext,
    identity: IdentityRecord,
  ): Promise<ControlPlaneCommandResult>;
  createSession(input: {
    readonly session: ActiveSession;
    readonly tokenHash: SessionTokenHash;
  }): Promise<ControlPlaneCommandResult>;
  revokeSession(
    context: VaultContext,
    session: RevokedSession,
  ): Promise<ControlPlaneCommandResult>;
};
