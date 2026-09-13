import { describe, expect, it } from 'vitest';
import {
  evaluateAccountSessionRevocation,
  planAccountSessionRevocation,
  planIdentityLink,
  planPersonalAccountProvision,
  planSessionStorage,
} from '@/server/control-plane/core';
import {
  activeControlPlaneSession,
  controlPlaneContext,
  controlPlaneIds,
  controlPlaneTokenHash,
  personalAccountProvision,
} from '@/tests/fixtures/control-plane';

describe('Identity/Vault ownership plans', () => {
  it('accepts one internally consistent personal account aggregate', () => {
    expect(planPersonalAccountProvision(personalAccountProvision())).toEqual({
      kind: 'accepted',
    });
  });

  it('rejects request-supplied ownership mismatches before an adapter writes', () => {
    const provision = personalAccountProvision();
    expect(
      planPersonalAccountProvision({
        ...provision,
        identity: {
          ...provision.identity,
          accountId: controlPlaneIds.accountB,
        },
      }),
    ).toEqual({ kind: 'rejected', reason: 'account-mismatch' });
    expect(
      planIdentityLink(controlPlaneContext(), {
        ...provision.identity,
        accountId: controlPlaneIds.accountB,
      }),
    ).toEqual({ kind: 'rejected', reason: 'account-mismatch' });
  });

  it('rejects a session whose account or Vault differs from its resolved owner', () => {
    const session = activeControlPlaneSession();
    expect(
      planSessionStorage({
        accountId: controlPlaneIds.accountA,
        vaultId: controlPlaneIds.vaultB,
        session,
        tokenHash: controlPlaneTokenHash,
      }),
    ).toEqual({ kind: 'rejected', reason: 'vault-mismatch' });
  });

  it('plans Account-wide session revocation from an injected timestamp', () => {
    const command = {
      accountId: controlPlaneIds.accountA,
      vaultId: controlPlaneIds.vaultA,
      revokedAt: 1_500,
    } as const;
    expect(planAccountSessionRevocation(command)).toEqual({
      kind: 'accepted',
      command,
    });
    expect(planAccountSessionRevocation({ ...command, revokedAt: -1 })).toEqual(
      { kind: 'rejected', reason: 'invalid-revocation-time' },
    );
    expect(
      planAccountSessionRevocation({ ...command, revokedAt: 1.5 }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-revocation-time' });
  });

  it('accepts only a confirmed owner with no remaining active sessions', () => {
    expect(
      evaluateAccountSessionRevocation({
        ownerCount: 1,
        revokedSessionCount: 3,
        remainingActiveSessionCount: 0,
      }),
    ).toEqual({ kind: 'applied', revokedSessionCount: 3 });
    expect(
      evaluateAccountSessionRevocation({
        ownerCount: 0,
        revokedSessionCount: 0,
        remainingActiveSessionCount: 0,
      }),
    ).toEqual({ kind: 'rejected', reason: 'owner-mismatch' });
    expect(
      evaluateAccountSessionRevocation({
        ownerCount: 1,
        revokedSessionCount: 2,
        remainingActiveSessionCount: 1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'incomplete-revocation' });
    for (const invalid of [
      {
        ownerCount: 2,
        revokedSessionCount: 0,
        remainingActiveSessionCount: 0,
      },
      {
        ownerCount: 1,
        revokedSessionCount: -1,
        remainingActiveSessionCount: 0,
      },
      {
        ownerCount: 1,
        revokedSessionCount: 0,
        remainingActiveSessionCount: Number.NaN,
      },
    ]) {
      expect(evaluateAccountSessionRevocation(invalid)).toEqual({
        kind: 'rejected',
        reason: 'invalid-result',
      });
    }
  });
});
