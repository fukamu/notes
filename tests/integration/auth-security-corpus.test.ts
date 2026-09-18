import { describe, expect, it, vi } from 'vitest';
import {
  createFakeEmailDelivery,
  createFakeEmailOtpAbuseKeys,
  createFakeEmailOtpChallengeStore,
  createFakeEmailOtpHasher,
  createFakeEmailOtpIdentityDirectory,
  createFakeEmailOtpRateLimits,
  createFakeEmailOtpSecrets,
} from '@/server/adapters/fake-email-otp';
import {
  createFakeOidcIdentityDirectory,
  createFakeOidcProvider,
  createFakeOidcSecrets,
  createFakeOidcTransactionStore,
} from '@/server/adapters/fake-oidc';
import { createFakeSessionResolver } from '@/server/adapters/fake-session-resolver';
import { webCryptoPkce } from '@/server/adapters/web-oidc';
import {
  emailOtpChallengeDecoder,
  emailOtpIdentityRecordDecoder,
  emailOtpRateLimitStateDecoder,
} from '@/server/core/email-otp';
import {
  oidcCallbackDecoder,
  oidcIdentityRecordDecoder,
  pendingOidcTransactionDecoder,
  verifiedOidcClaimsDecoder,
} from '@/server/core/oidc';
import {
  authorizeSession,
  authorizeVaultOperation,
  rotateSession,
  sessionRecordDecoder,
} from '@/server/core/session';
import {
  completeEmailOtp,
  startEmailOtp,
  type EmailOtpChallengeStore,
  type EmailOtpHasherPort,
} from '@/server/email-otp-boundary';
import {
  completeGoogleOidc,
  startGoogleOidc,
  type OidcVerifiedClaimsPort,
} from '@/server/oidc-boundary';
import {
  deriveVaultContext,
  type SessionCredentialResolver,
} from '@/server/session-boundary';
import {
  emailOtpFixture,
  emailOtpIdentityRecord,
} from '@/tests/fixtures/email-otp';
import {
  fixtureOidcClaims,
  oidcConfiguration,
  oidcFixture,
  oidcIdentityRecord,
} from '@/tests/fixtures/oidc';
import {
  boundedMalformedSecurityCorpus,
  containsSensitiveMarker,
  securityCorpusMarker,
} from '@/tests/fixtures/security-corpus';
import {
  cookieHeader,
  fixtureActiveSession,
  sessionFixtureIds,
} from '@/tests/fixtures/session';

const clock = { nowEpochSeconds: () => 1_500 } as const;
const otpClock = { nowEpochSeconds: () => 1_000 } as const;
const networkContext = { remoteAddress: 'security-corpus-network' } as const;
const otpRateLimitKeys = {
  address: emailOtpFixture.addressKey,
  network: emailOtpFixture.networkKey,
} as const;

describe('authentication boundary security corpus', () => {
  it('rejects a bounded malformed corpus at every persisted auth decoder', () => {
    const decoders = [
      sessionRecordDecoder,
      pendingOidcTransactionDecoder,
      oidcCallbackDecoder,
      verifiedOidcClaimsDecoder,
      oidcIdentityRecordDecoder,
      emailOtpChallengeDecoder,
      emailOtpRateLimitStateDecoder,
      emailOtpIdentityRecordDecoder,
    ] as const;

    for (const boundary of decoders) {
      for (const malformed of boundedMalformedSecurityCorpus()) {
        const result = boundary.decode(malformed.value);
        expect(result, malformed.name).toMatchObject({ ok: false });
        expect(
          containsSensitiveMarker(result, [securityCorpusMarker]),
          malformed.name,
        ).toBe(false);
      }
    }
  });

  it('rejects CSRF before lookup and rejects fixed or stale sessions after rotation', async () => {
    const resolver: SessionCredentialResolver = {
      findSessionByToken: vi.fn(async () => {
        throw new Error(securityCorpusMarker);
      }),
    };
    const csrfResults = await Promise.all(
      [
        {
          originHeader: 'https://evil.example',
          secFetchSiteHeader: 'cross-site',
        },
        { originHeader: null, secFetchSiteHeader: 'same-origin' },
        {
          originHeader: 'https://notes.example',
          secFetchSiteHeader: 'same-site',
        },
      ].map((metadata) =>
        deriveVaultContext(
          {
            method: 'POST',
            cookieHeader: cookieHeader(),
            expectedOrigin: 'https://notes.example',
            now: 1_500,
            ...metadata,
          },
          resolver,
        ),
      ),
    );
    expect(csrfResults.every((result) => result.kind === 'forbidden')).toBe(
      true,
    );
    expect(resolver.findSessionByToken).not.toHaveBeenCalled();
    expect(containsSensitiveMarker(csrfResults, [securityCorpusMarker])).toBe(
      false,
    );

    const active = fixtureActiveSession();
    const previousAccess = authorizeSession(active, 1_400);
    expect(previousAccess.kind).toBe('authenticated');
    if (previousAccess.kind !== 'authenticated') return;
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

    const rotatedResolver = createFakeSessionResolver([
      { token: sessionFixtureIds.token, record: rotation.previous },
      { token: sessionFixtureIds.otherToken, record: rotation.current },
    ]);
    const request = {
      method: 'POST',
      originHeader: 'https://notes.example',
      secFetchSiteHeader: 'same-origin',
      expectedOrigin: 'https://notes.example',
      now: 1_600,
    } as const;
    await expect(
      deriveVaultContext(
        { ...request, cookieHeader: cookieHeader() },
        rotatedResolver,
      ),
    ).resolves.toEqual({ kind: 'anonymous', reason: 'revoked' });
    await expect(
      deriveVaultContext(
        {
          ...request,
          cookieHeader: cookieHeader(sessionFixtureIds.otherToken),
        },
        rotatedResolver,
      ),
    ).resolves.toMatchObject({
      kind: 'authenticated',
      context: {
        sessionId: sessionFixtureIds.nextSessionId,
        sessionEpoch: sessionFixtureIds.nextEpoch,
      },
    });
    expect(
      authorizeVaultOperation(previousAccess.context, rotation.current, 1_600),
    ).toEqual({ kind: 'denied', reason: 'session-mismatch' });
  });

  it('allows one OIDC callback winner and never exposes replay or provider secrets', async () => {
    const transactions = createFakeOidcTransactionStore();
    await expect(
      startGoogleOidc({
        configuration: oidcConfiguration,
        redirectUri: oidcFixture.redirectUri,
        intent: 'sign-in',
        clock,
        secrets: createFakeOidcSecrets({
          state: oidcFixture.state,
          nonce: oidcFixture.nonce,
          codeVerifier: oidcFixture.verifier,
        }),
        pkce: webCryptoPkce,
        transactions,
      }),
    ).resolves.toMatchObject({ kind: 'redirect' });
    const provider = createFakeOidcProvider(
      new Map([[oidcFixture.code, fixtureOidcClaims()]]),
    );
    const completion = {
      callback: { state: oidcFixture.state, code: oidcFixture.code },
      configuration: oidcConfiguration,
      clock,
      transactions,
      provider,
      identities: createFakeOidcIdentityDirectory({
        identities: [oidcIdentityRecord],
      }),
    } as const;
    const results = await Promise.all([
      completeGoogleOidc(completion),
      completeGoogleOidc(completion),
    ]);
    expect(results.filter((result) => result.kind === 'resolved')).toHaveLength(
      1,
    );
    expect(results.filter((result) => result.kind === 'failed')).toHaveLength(
      1,
    );
    expect(provider.exchanges()).toHaveLength(1);
    expect(
      containsSensitiveMarker(results, [
        oidcFixture.state,
        oidcFixture.nonce,
        oidcFixture.verifier,
        oidcFixture.code,
      ]),
    ).toBe(false);

    const failedTransactions = createFakeOidcTransactionStore();
    await startGoogleOidc({
      configuration: oidcConfiguration,
      redirectUri: oidcFixture.redirectUri,
      intent: 'sign-in',
      clock,
      secrets: createFakeOidcSecrets({
        state: oidcFixture.state,
        nonce: oidcFixture.nonce,
        codeVerifier: oidcFixture.verifier,
      }),
      pkce: webCryptoPkce,
      transactions: failedTransactions,
    });
    const failingProvider: OidcVerifiedClaimsPort = {
      async exchangeCodeForVerifiedClaims() {
        throw new Error(securityCorpusMarker);
      },
    };
    const failed = await completeGoogleOidc({
      callback: { state: oidcFixture.state, code: oidcFixture.code },
      configuration: oidcConfiguration,
      clock,
      transactions: failedTransactions,
      provider: failingProvider,
      identities: createFakeOidcIdentityDirectory(),
    });
    expect(failed).toEqual({
      kind: 'failed',
      error: 'authentication-failed',
    });
    expect(
      containsSensitiveMarker(failed, [securityCorpusMarker, oidcFixture.code]),
    ).toBe(false);
  });

  it('keeps OTP enumeration and secret-bearing adapter failures indistinguishable', async () => {
    const invalid = otpRuntime();
    const invalidResult = await startEmailOtp({
      ...otpStartInput(invalid),
      address: 'not-an-address',
    });

    const limited = otpRuntime();
    const limitedResult = await startEmailOtp({
      ...otpStartInput(limited),
      rateLimits: { reserve: async () => false },
    });

    const hashFailure = otpRuntime();
    const failingHasher: EmailOtpHasherPort = {
      ...hashFailure.hasher,
      async createDigest() {
        throw new Error(securityCorpusMarker);
      },
    };
    const hashFailureResult = await startEmailOtp({
      ...otpStartInput(hashFailure),
      hasher: failingHasher,
    });

    const storeFailure = otpRuntime();
    const failingStore: EmailOtpChallengeStore = {
      ...storeFailure.challenges,
      async insertPending() {
        throw new Error(securityCorpusMarker);
      },
    };
    const storeFailureResult = await startEmailOtp({
      ...otpStartInput(storeFailure),
      challenges: failingStore,
    });

    const deliveryFailure = otpRuntime();
    const deliveryFailureResult = await startEmailOtp({
      ...otpStartInput(deliveryFailure),
      delivery: createFakeEmailDelivery({ fail: () => true }),
    });

    const results = [
      invalidResult,
      limitedResult,
      hashFailureResult,
      storeFailureResult,
      deliveryFailureResult,
    ];
    expect(results).toEqual(
      results.map(() => ({
        kind: 'accepted',
        challengeId: emailOtpFixture.challengeId,
      })),
    );
    expect(
      containsSensitiveMarker(results, [
        securityCorpusMarker,
        emailOtpFixture.code,
      ]),
    ).toBe(false);

    const completionFailure = await completeEmailOtp({
      challengeId: emailOtpFixture.challengeId,
      code: emailOtpFixture.code,
      clock: otpClock,
      hasher: createFakeEmailOtpHasher(),
      challenges: {
        async insertPending() {},
        async findById() {
          throw new Error(securityCorpusMarker);
        },
        async compareAndSwap() {
          return true;
        },
      },
      identities: createFakeEmailOtpIdentityDirectory({
        identities: [emailOtpIdentityRecord],
      }),
    });
    expect(completionFailure).toEqual({
      kind: 'failed',
      error: 'verification-failed',
    });
    expect(
      containsSensitiveMarker(completionFailure, [
        securityCorpusMarker,
        emailOtpFixture.code,
      ]),
    ).toBe(false);
  });
});

function otpRuntime() {
  return {
    clock: otpClock,
    secrets: createFakeEmailOtpSecrets({
      challengeIds: [emailOtpFixture.challengeId],
      codes: [emailOtpFixture.code],
      salts: [emailOtpFixture.salt],
    }),
    hasher: createFakeEmailOtpHasher(),
    challenges: createFakeEmailOtpChallengeStore(),
    abuseKeys: createFakeEmailOtpAbuseKeys(otpRateLimitKeys),
    rateLimits: createFakeEmailOtpRateLimits(),
    delivery: createFakeEmailDelivery(),
  };
}

function otpStartInput(runtime: ReturnType<typeof otpRuntime>) {
  return {
    address: emailOtpFixture.address,
    intent: 'sign-in' as const,
    networkContext,
    ...runtime,
  };
}
