import { decodeOrThrow } from '@/lib/codec/core';
import {
  parseAccountId,
  parseIdentityId,
  parseSessionEpoch,
  parseSessionId,
  parseVaultId,
  type VaultContext,
} from '@/lib/domain/identity';
import { createActiveSession } from '@/server/core/session';
import type { PersonalAccountProvision } from '@/server/control-plane/core';
import {
  sessionTokenHashDecoder,
  type SessionTokenHash,
} from '@/server/control-plane/records';

export const controlPlaneIds = {
  accountA: parseAccountId('01991f20-61d2-7000-8000-000000001101'),
  accountB: parseAccountId('01991f20-61d2-7000-8000-000000001102'),
  vaultA: parseVaultId('01991f20-61d2-7000-8000-000000001201'),
  vaultB: parseVaultId('01991f20-61d2-7000-8000-000000001202'),
  identityA: parseIdentityId('01991f20-61d2-7000-8000-000000001301'),
  identityB: parseIdentityId('01991f20-61d2-7000-8000-000000001302'),
  sessionA: parseSessionId('01991f20-61d2-7000-8000-000000001401'),
  epoch: parseSessionEpoch(1),
} as const;

export const controlPlaneTokenHash: SessionTokenHash = decodeOrThrow(
  sessionTokenHashDecoder,
  'A'.repeat(43),
  'control-plane token hash fixture',
);

export function personalAccountProvision(
  account: 'a' | 'b' = 'a',
): PersonalAccountProvision {
  const accountId =
    account === 'a' ? controlPlaneIds.accountA : controlPlaneIds.accountB;
  const vaultId =
    account === 'a' ? controlPlaneIds.vaultA : controlPlaneIds.vaultB;
  const identityId =
    account === 'a' ? controlPlaneIds.identityA : controlPlaneIds.identityB;
  return {
    account: { accountId, createdAt: 1_000 },
    vault: { vaultId, accountId, createdAt: 1_000 },
    identity: {
      identityId,
      accountId,
      provider: 'google-oidc',
      issuer: 'https://accounts.google.com',
      subject: account === 'a' ? 'google-subject-a' : 'google-subject-b',
      createdAt: 1_000,
    },
  };
}

export function activeControlPlaneSession() {
  const decision = createActiveSession({
    sessionId: controlPlaneIds.sessionA,
    accountId: controlPlaneIds.accountA,
    vaultId: controlPlaneIds.vaultA,
    sessionEpoch: controlPlaneIds.epoch,
    issuedAt: 1_000,
    expiresAt: 2_000,
  });
  if (decision.kind === 'rejected') throw new Error('invalid session fixture');
  return decision.session;
}

export function controlPlaneContext(): VaultContext {
  return {
    accountId: controlPlaneIds.accountA,
    vaultId: controlPlaneIds.vaultA,
    sessionId: controlPlaneIds.sessionA,
    sessionEpoch: controlPlaneIds.epoch,
  };
}
