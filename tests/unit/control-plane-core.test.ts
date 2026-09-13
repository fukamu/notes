import { describe, expect, it } from 'vitest';
import {
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
});
