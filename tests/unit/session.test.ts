import { describe, expect, it } from 'vitest';
import {
  accountIdDecoder,
  identityIdDecoder,
  parseSessionEpoch,
  sessionEpochDecoder,
  sessionIdDecoder,
  sessionTokenDecoder,
  vaultIdDecoder,
} from '@/lib/domain/identity';
import {
  clearSessionCookie,
  setSessionCookie,
} from '@/server/core/session-cookie';
import {
  authorizeSession,
  authorizeVaultOperation,
  createActiveSession,
  revokeSession,
  rotateSession,
  sessionRecordDecoder,
} from '@/server/core/session';
import { serializeSessionCookie } from '@/server/adapters/web-session';
import {
  fixtureActiveSession,
  sessionFixtureIds,
} from '@/tests/fixtures/session';

describe('identity and session codecs', () => {
  it('brands only validated identifiers, epochs, and high-entropy tokens', () => {
    const uuid = '01991f20-61d2-7000-8000-000000000999';
    for (const decoder of [
      accountIdDecoder,
      vaultIdDecoder,
      sessionIdDecoder,
      identityIdDecoder,
    ]) {
      expect(decoder.decode(uuid).ok).toBe(true);
      expect(decoder.decode('01991f20-61d2-4000-8000-000000000999').ok).toBe(
        false,
      );
    }
    for (const value of [0, -1, 1.5, 2_147_483_648]) {
      expect(sessionEpochDecoder.decode(value).ok).toBe(false);
    }
    expect(sessionTokenDecoder.decode('A'.repeat(43)).ok).toBe(true);
    for (const value of [
      'short',
      'A'.repeat(42),
      `${'A'.repeat(42)};`,
      `${'A'.repeat(42)}B`,
    ]) {
      expect(sessionTokenDecoder.decode(value).ok).toBe(false);
    }
  });

  it('rejects malformed storage records and invalid timelines', () => {
    const active = fixtureActiveSession();
    expect(sessionRecordDecoder.decode(active).ok).toBe(true);
    expect(
      sessionRecordDecoder.decode({ ...active, unexpected: true }).ok,
    ).toBe(false);
    expect(
      sessionRecordDecoder.decode({ ...active, expiresAt: active.issuedAt }).ok,
    ).toBe(false);
    expect(sessionRecordDecoder.decode({ ...active, sessionEpoch: 0 }).ok).toBe(
      false,
    );
  });
});

describe('session lifecycle', () => {
  it('creates and authorizes only active, unexpired sessions', () => {
    const active = fixtureActiveSession();
    expect(authorizeSession(undefined, 1_500)).toEqual({
      kind: 'anonymous',
      reason: 'missing-session',
    });
    expect(authorizeSession(active, 1_500)).toEqual({
      kind: 'authenticated',
      context: {
        accountId: sessionFixtureIds.accountId,
        vaultId: sessionFixtureIds.vaultId,
        sessionId: sessionFixtureIds.sessionId,
        sessionEpoch: sessionFixtureIds.epoch,
      },
    });
    expect(authorizeSession(active, active.expiresAt)).toEqual({
      kind: 'denied',
      reason: 'expired',
    });
    expect(authorizeSession(active, Number.NaN)).toEqual({
      kind: 'denied',
      reason: 'invalid-clock',
    });
    expect(
      createActiveSession({ ...active, issuedAt: 2_000, expiresAt: 2_000 }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-lifetime' });
  });

  it('rotates identifiers and epochs instead of accepting session fixation', () => {
    const active = fixtureActiveSession();
    const rotation = rotateSession(active, {
      nextSessionId: sessionFixtureIds.nextSessionId,
      nextSessionEpoch: sessionFixtureIds.nextEpoch,
      currentToken: sessionFixtureIds.token,
      nextToken: sessionFixtureIds.otherToken,
      rotatedAt: 1_500,
      expiresAt: 3_000,
    });
    expect(rotation.kind).toBe('rotated');
    if (rotation.kind !== 'rotated') return;
    expect(rotation.previous).toMatchObject({
      kind: 'revoked',
      reason: 'rotated',
      revokedAt: 1_500,
    });
    expect(rotation.current).toMatchObject({
      kind: 'active',
      sessionId: sessionFixtureIds.nextSessionId,
      sessionEpoch: sessionFixtureIds.nextEpoch,
      accountId: sessionFixtureIds.accountId,
      vaultId: sessionFixtureIds.vaultId,
    });
    expect(rotation.nextToken).toBe(sessionFixtureIds.otherToken);
    expect(authorizeSession(rotation.previous, 1_600)).toEqual({
      kind: 'denied',
      reason: 'revoked',
    });
    expect(authorizeSession(rotation.current, 1_600).kind).toBe(
      'authenticated',
    );

    expect(
      rotateSession(active, {
        nextSessionId: sessionFixtureIds.sessionId,
        nextSessionEpoch: sessionFixtureIds.nextEpoch,
        currentToken: sessionFixtureIds.token,
        nextToken: sessionFixtureIds.otherToken,
        rotatedAt: 1_500,
        expiresAt: 3_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'session-id-reused' });
    expect(
      rotateSession(active, {
        nextSessionId: sessionFixtureIds.nextSessionId,
        nextSessionEpoch: sessionFixtureIds.epoch,
        currentToken: sessionFixtureIds.token,
        nextToken: sessionFixtureIds.otherToken,
        rotatedAt: 1_500,
        expiresAt: 3_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'epoch-not-incremented' });
    expect(
      rotateSession(active, {
        nextSessionId: sessionFixtureIds.nextSessionId,
        nextSessionEpoch: sessionFixtureIds.nextEpoch,
        currentToken: sessionFixtureIds.token,
        nextToken: sessionFixtureIds.token,
        rotatedAt: 1_500,
        expiresAt: 3_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'session-token-reused' });
  });

  it('revokes idempotently and rejects stale operation context', () => {
    const active = fixtureActiveSession();
    const access = authorizeSession(active, 1_500);
    expect(access.kind).toBe('authenticated');
    if (access.kind !== 'authenticated') return;

    expect(authorizeVaultOperation(access.context, active, 1_500)).toEqual({
      kind: 'authorized',
    });
    const advancedEpoch = {
      ...active,
      sessionEpoch: parseSessionEpoch(2),
    };
    expect(
      authorizeVaultOperation(access.context, advancedEpoch, 1_500),
    ).toEqual({ kind: 'denied', reason: 'epoch-mismatch' });
    expect(
      authorizeVaultOperation(
        { ...access.context, sessionId: sessionFixtureIds.nextSessionId },
        active,
        1_500,
      ),
    ).toEqual({ kind: 'denied', reason: 'session-mismatch' });
    expect(
      authorizeVaultOperation(
        { ...access.context, accountId: sessionFixtureIds.otherAccountId },
        active,
        1_500,
      ),
    ).toEqual({ kind: 'denied', reason: 'account-mismatch' });
    expect(
      authorizeVaultOperation(
        { ...access.context, vaultId: sessionFixtureIds.otherVaultId },
        active,
        1_500,
      ),
    ).toEqual({ kind: 'denied', reason: 'vault-mismatch' });

    const revoked = revokeSession(active, 1_600, 'logout');
    expect(revoked.kind).toBe('revoked');
    if (revoked.kind !== 'revoked') return;
    expect(
      authorizeVaultOperation(access.context, revoked.session, 1_700),
    ).toEqual({ kind: 'denied', reason: 'revoked' });
    expect(revokeSession(revoked.session, 1_800, 'security')).toEqual({
      kind: 'unchanged',
      session: revoked.session,
    });
  });
});

describe('session cookie policy', () => {
  it('uses a host-only Secure HttpOnly Strict cookie and explicit clearing', () => {
    const decision = setSessionCookie(sessionFixtureIds.token, 3_600);
    expect(decision.kind).toBe('accepted');
    if (decision.kind !== 'accepted') return;
    expect(serializeSessionCookie(decision.instruction)).toBe(
      `${'__Host-fukamu_session='}${sessionFixtureIds.token}; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict`,
    );
    expect(serializeSessionCookie(clearSessionCookie())).toBe(
      '__Host-fukamu_session=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict',
    );
    expect(setSessionCookie(sessionFixtureIds.token, 0)).toEqual({
      kind: 'rejected',
      reason: 'invalid-max-age',
    });
  });
});
