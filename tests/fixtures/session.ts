import {
  parseAccountId,
  parseIdentityId,
  parseSessionEpoch,
  parseSessionId,
  parseSessionToken,
  parseVaultId,
  type SessionToken,
} from '@/lib/domain/identity';
import { createActiveSession, type ActiveSession } from '@/server/core/session';

export const sessionFixtureIds = {
  accountId: parseAccountId('01991f20-61d2-7000-8000-000000000101'),
  otherAccountId: parseAccountId('01991f20-61d2-7000-8000-000000000102'),
  vaultId: parseVaultId('01991f20-61d2-7000-8000-000000000201'),
  otherVaultId: parseVaultId('01991f20-61d2-7000-8000-000000000202'),
  sessionId: parseSessionId('01991f20-61d2-7000-8000-000000000301'),
  nextSessionId: parseSessionId('01991f20-61d2-7000-8000-000000000302'),
  identityId: parseIdentityId('01991f20-61d2-7000-8000-000000000401'),
  epoch: parseSessionEpoch(1),
  nextEpoch: parseSessionEpoch(2),
  token: parseSessionToken('A'.repeat(43)),
  otherToken: parseSessionToken(`${'B'.repeat(42)}A`),
} as const;

export function fixtureActiveSession(
  input: {
    readonly issuedAt?: number;
    readonly expiresAt?: number;
  } = {},
): ActiveSession {
  const decision = createActiveSession({
    sessionId: sessionFixtureIds.sessionId,
    accountId: sessionFixtureIds.accountId,
    vaultId: sessionFixtureIds.vaultId,
    sessionEpoch: sessionFixtureIds.epoch,
    issuedAt: input.issuedAt ?? 1_000,
    expiresAt: input.expiresAt ?? 2_000,
  });
  if (decision.kind === 'rejected') {
    throw new Error('invalid session fixture');
  }
  return decision.session;
}

export function cookieHeader(
  token: SessionToken = sessionFixtureIds.token,
): string {
  return `__Host-fukamu_session=${token}`;
}
