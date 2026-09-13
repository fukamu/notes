import { describe, expect, it } from 'vitest';
import {
  oidcAuthorizationEndpointDecoder,
  oidcIssuerDecoder,
  oidcNonceDecoder,
  oidcRedirectUriDecoder,
  oidcStateDecoder,
  parseOidcNonce,
  pkceCodeChallengeDecoder,
  pkceCodeVerifierDecoder,
} from '@/lib/domain/oidc';
import {
  createOidcAuthorizationRequest,
  createOidcTransaction,
  decideOidcIdentityResolution,
  establishOidcSession,
  oidcCallbackDecoder,
  pendingOidcTransactionDecoder,
  validateOidcClaims,
  validateOidcTransaction,
  verifiedOidcClaimsDecoder,
} from '@/server/core/oidc';
import {
  fixtureActiveSession,
  sessionFixtureIds,
} from '@/tests/fixtures/session';
import {
  fixtureOidcClaims,
  fixtureOidcTransaction,
  oidcConfiguration,
  oidcFixture,
  oidcIdentityRecord,
} from '@/tests/fixtures/oidc';

describe('OIDC boundary codecs', () => {
  it('accepts only bounded independent secrets and exact safe URIs', () => {
    expect(oidcStateDecoder.decode(oidcFixture.state).ok).toBe(true);
    expect(oidcNonceDecoder.decode(oidcFixture.nonce).ok).toBe(true);
    expect(pkceCodeVerifierDecoder.decode(oidcFixture.verifier).ok).toBe(true);
    expect(pkceCodeChallengeDecoder.decode(oidcFixture.challenge).ok).toBe(
      true,
    );
    for (const value of ['short', `${'A'.repeat(42)}B`, 'A'.repeat(129)]) {
      expect(oidcStateDecoder.decode(value).ok).toBe(false);
    }
    expect(pkceCodeVerifierDecoder.decode(`${'A'.repeat(42)}!`).ok).toBe(false);
    expect(
      oidcAuthorizationEndpointDecoder.decode('http://accounts.google.com/auth')
        .ok,
    ).toBe(false);
    expect(oidcIssuerDecoder.decode('accounts.google.com').ok).toBe(true);
    expect(
      oidcRedirectUriDecoder.decode('http://localhost:3000/auth/callback').ok,
    ).toBe(true);
    for (const value of [
      'http://notes.example/auth/callback',
      'https://user@notes.example/auth/callback',
      'https://notes.example/auth/callback#fragment',
      ' https://notes.example/auth/callback',
    ]) {
      expect(oidcRedirectUriDecoder.decode(value).ok).toBe(false);
    }
  });

  it('rejects malformed persisted transactions and unverified claims', () => {
    expect(
      pendingOidcTransactionDecoder.decode(fixtureOidcTransaction()).ok,
    ).toBe(true);
    expect(
      pendingOidcTransactionDecoder.decode({
        ...fixtureOidcTransaction(),
        expiresAtEpochSeconds: 1_601,
      }).ok,
    ).toBe(false);
    expect(
      pendingOidcTransactionDecoder.decode({
        ...fixtureOidcTransaction(),
        state: oidcFixture.nonce,
      }).ok,
    ).toBe(false);
    expect(verifiedOidcClaimsDecoder.decode(fixtureOidcClaims()).ok).toBe(true);
    expect(
      verifiedOidcClaimsDecoder.decode(
        fixtureOidcClaims({ email_verified: false }),
      ).ok,
    ).toBe(false);
    expect(
      oidcCallbackDecoder.decode({
        state: oidcFixture.state,
        code: oidcFixture.code,
        error: 'access_denied',
      }).ok,
    ).toBe(false);
    expect(
      oidcCallbackDecoder.decode({
        state: oidcFixture.state,
        error_description: 'missing error',
      }).ok,
    ).toBe(false);
  });
});

describe('OIDC transaction and claims policy', () => {
  it('creates a ten-minute single-purpose transaction and S256 request', () => {
    const decision = createOidcTransaction({
      configuration: oidcConfiguration,
      state: oidcFixture.state,
      nonce: oidcFixture.nonce,
      codeVerifier: oidcFixture.verifier,
      redirectUri: oidcFixture.redirectUri,
      purpose: { kind: 'sign-in' },
      nowEpochSeconds: 1_000,
    });
    expect(decision.kind).toBe('created');
    if (decision.kind !== 'created') return;
    expect(decision.transaction.expiresAtEpochSeconds).toBe(1_600);
    expect(
      createOidcAuthorizationRequest(
        oidcConfiguration,
        decision.transaction,
        oidcFixture.challenge,
      ),
    ).toMatchObject({
      responseType: 'code',
      scope: 'openid email',
      codeChallengeMethod: 'S256',
      redirectUri: oidcFixture.redirectUri,
    });
    expect(
      createOidcTransaction({
        configuration: oidcConfiguration,
        state: oidcFixture.state,
        nonce: oidcFixture.nonce,
        codeVerifier: oidcFixture.verifier,
        redirectUri: oidcFixture.otherRedirectUri,
        purpose: { kind: 'sign-in' },
        nowEpochSeconds: 1_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'redirect-not-allowed' });
    expect(
      createOidcTransaction({
        configuration: oidcConfiguration,
        state: oidcFixture.state,
        nonce: parseOidcNonce(oidcFixture.state),
        codeVerifier: oidcFixture.verifier,
        redirectUri: oidcFixture.redirectUri,
        purpose: { kind: 'sign-in' },
        nowEpochSeconds: 1_000,
      }),
    ).toEqual({ kind: 'rejected', reason: 'state-nonce-reused' });
    expect(
      createOidcTransaction({
        configuration: oidcConfiguration,
        state: oidcFixture.state,
        nonce: oidcFixture.nonce,
        codeVerifier: oidcFixture.verifier,
        redirectUri: oidcFixture.redirectUri,
        purpose: { kind: 'sign-in' },
        nowEpochSeconds: Number.MAX_SAFE_INTEGER,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-clock' });
  });

  it('validates exact state, redirect, issuer, audience, azp, time, and nonce', () => {
    const transaction = fixtureOidcTransaction();
    expect(
      validateOidcTransaction(
        transaction,
        oidcFixture.state,
        oidcConfiguration,
        1_500,
      ),
    ).toEqual({ kind: 'valid' });
    expect(
      validateOidcTransaction(
        transaction,
        oidcFixture.otherState,
        oidcConfiguration,
        1_500,
      ),
    ).toEqual({ kind: 'rejected', reason: 'state-mismatch' });
    expect(
      validateOidcTransaction(
        transaction,
        oidcFixture.state,
        oidcConfiguration,
        1_600,
      ),
    ).toEqual({ kind: 'rejected', reason: 'expired-transaction' });

    const validClaims = verifiedOidcClaimsDecoder.decode(fixtureOidcClaims());
    expect(validClaims.ok).toBe(true);
    if (!validClaims.ok) return;
    expect(
      validateOidcClaims(
        validClaims.value,
        transaction,
        oidcConfiguration,
        1_500,
      ),
    ).toEqual({
      kind: 'valid',
      identityKey: {
        issuer: oidcFixture.issuer,
        subject: oidcFixture.subject,
      },
      email: oidcFixture.email,
    });

    const cases = [
      [fixtureOidcClaims({ iss: oidcFixture.otherIssuer }), 'issuer-mismatch'],
      [
        fixtureOidcClaims({ aud: oidcFixture.otherClientId }),
        'audience-mismatch',
      ],
      [
        fixtureOidcClaims({
          aud: [oidcFixture.clientId, oidcFixture.otherClientId],
          azp: oidcFixture.otherClientId,
        }),
        'authorized-party-mismatch',
      ],
      [fixtureOidcClaims({ exp: 1_500 }), 'expired-token'],
      [fixtureOidcClaims({ iat: 1_561 }), 'invalid-issued-at'],
      [fixtureOidcClaims({ nonce: oidcFixture.otherNonce }), 'nonce-mismatch'],
    ] as const;
    for (const [candidate, reason] of cases) {
      const decoded = verifiedOidcClaimsDecoder.decode(candidate);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) continue;
      expect(
        validateOidcClaims(
          decoded.value,
          transaction,
          oidcConfiguration,
          1_500,
        ),
      ).toEqual({ kind: 'rejected', reason });
    }
  });
});

describe('OIDC identity linking and session policy', () => {
  const identityKey = {
    issuer: oidcFixture.issuer,
    subject: oidcFixture.subject,
  } as const;

  it('keys identities by issuer plus subject and never auto-links by email', () => {
    expect(
      decideOidcIdentityResolution({
        purpose: { kind: 'sign-in' },
        identityKey,
        email: oidcFixture.email,
        existingIdentity: oidcIdentityRecord,
      }),
    ).toEqual({
      kind: 'authenticate-existing',
      identity: oidcIdentityRecord,
    });
    expect(
      decideOidcIdentityResolution({
        purpose: { kind: 'sign-in' },
        identityKey,
        email: oidcFixture.email,
        verifiedEmailAccountId: sessionFixtureIds.accountId,
      }),
    ).toEqual({ kind: 'rejected', reason: 'email-collision' });
    expect(
      decideOidcIdentityResolution({
        purpose: { kind: 'sign-in' },
        identityKey,
        email: oidcFixture.email,
      }),
    ).toEqual({
      kind: 'provision-account',
      identityKey,
      email: oidcFixture.email,
    });
  });

  it('links only to the explicitly authenticated account', () => {
    expect(
      decideOidcIdentityResolution({
        purpose: { kind: 'link', accountId: sessionFixtureIds.accountId },
        identityKey,
        email: oidcFixture.email,
      }),
    ).toEqual({
      kind: 'link-identity',
      accountId: sessionFixtureIds.accountId,
      identityKey,
      email: oidcFixture.email,
    });
    expect(
      decideOidcIdentityResolution({
        purpose: { kind: 'link', accountId: sessionFixtureIds.otherAccountId },
        identityKey,
        email: oidcFixture.email,
        existingIdentity: oidcIdentityRecord,
      }),
    ).toEqual({
      kind: 'rejected',
      reason: 'identity-owned-by-another-account',
    });
    expect(
      decideOidcIdentityResolution({
        purpose: { kind: 'link', accountId: sessionFixtureIds.accountId },
        identityKey,
        email: oidcFixture.email,
        verifiedEmailAccountId: sessionFixtureIds.otherAccountId,
      }),
    ).toEqual({ kind: 'rejected', reason: 'email-collision' });
  });

  it('creates a fresh login session and rotates an existing same-vault session', () => {
    const created = establishOidcSession({
      principal: oidcIdentityRecord,
      nextSessionId: sessionFixtureIds.nextSessionId,
      nextSessionEpoch: sessionFixtureIds.epoch,
      nextToken: sessionFixtureIds.otherToken,
      now: 1_500,
      expiresAt: 3_000,
    });
    expect(created).toMatchObject({
      kind: 'created',
      token: sessionFixtureIds.otherToken,
      session: {
        accountId: sessionFixtureIds.accountId,
        vaultId: sessionFixtureIds.vaultId,
        sessionEpoch: sessionFixtureIds.epoch,
      },
    });

    const rotated = establishOidcSession({
      principal: oidcIdentityRecord,
      currentSession: fixtureActiveSession(),
      currentToken: sessionFixtureIds.token,
      nextSessionId: sessionFixtureIds.nextSessionId,
      nextSessionEpoch: sessionFixtureIds.nextEpoch,
      nextToken: sessionFixtureIds.otherToken,
      now: 1_500,
      expiresAt: 3_000,
    });
    expect(rotated).toMatchObject({
      kind: 'rotated',
      previous: { kind: 'revoked', reason: 'rotated' },
      current: {
        sessionId: sessionFixtureIds.nextSessionId,
        sessionEpoch: sessionFixtureIds.nextEpoch,
      },
    });
    expect(
      establishOidcSession({
        principal: {
          accountId: sessionFixtureIds.otherAccountId,
          vaultId: sessionFixtureIds.otherVaultId,
        },
        currentSession: fixtureActiveSession(),
        currentToken: sessionFixtureIds.token,
        nextSessionId: sessionFixtureIds.nextSessionId,
        nextSessionEpoch: sessionFixtureIds.nextEpoch,
        nextToken: sessionFixtureIds.otherToken,
        now: 1_500,
        expiresAt: 3_000,
      }),
    ).toEqual({
      kind: 'rejected',
      reason: 'account-switch-requires-logout',
    });
  });
});
