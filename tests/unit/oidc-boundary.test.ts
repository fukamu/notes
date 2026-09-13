import { describe, expect, it, vi } from 'vitest';
import {
  createFakeOidcIdentityDirectory,
  createFakeOidcProvider,
  createFakeOidcSecrets,
  createFakeOidcTransactionStore,
} from '@/server/adapters/fake-oidc';
import {
  oidcCallbackInputFromUrl,
  serializeOidcAuthorizationRequest,
  webCryptoPkce,
} from '@/server/adapters/web-oidc';
import {
  completeGoogleOidc,
  startGoogleOidc,
  type OidcIdentityDirectory,
} from '@/server/oidc-boundary';
import {
  fixtureOidcClaims,
  oidcConfiguration,
  oidcFixture,
  oidcIdentityRecord,
} from '@/tests/fixtures/oidc';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const clock = { nowEpochSeconds: () => 1_500 } as const;

function secrets() {
  return createFakeOidcSecrets({
    state: oidcFixture.state,
    nonce: oidcFixture.nonce,
    codeVerifier: oidcFixture.verifier,
  });
}

async function startedTransaction() {
  const transactions = createFakeOidcTransactionStore();
  const start = await startGoogleOidc({
    configuration: oidcConfiguration,
    redirectUri: oidcFixture.redirectUri,
    intent: 'sign-in',
    clock,
    secrets: secrets(),
    pkce: webCryptoPkce,
    transactions,
  });
  expect(start.kind).toBe('redirect');
  return { transactions, start };
}

describe('Google OIDC start boundary', () => {
  it('persists verifier server-side and creates the RFC 7636 S256 request', async () => {
    const { transactions, start } = await startedTransaction();
    expect(transactions.remaining()).toBe(1);
    if (start.kind !== 'redirect') return;
    expect(start.request.codeChallenge).toBe(oidcFixture.challenge);
    const url = new URL(serializeOidcAuthorizationRequest(start.request));
    expect(url.origin + url.pathname).toBe(
      'https://accounts.google.com/o/oauth2/v2/auth',
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: 'code',
      client_id: oidcFixture.clientId,
      redirect_uri: oidcFixture.redirectUri,
      scope: 'openid email',
      state: oidcFixture.state,
      nonce: oidcFixture.nonce,
      code_challenge: oidcFixture.challenge,
      code_challenge_method: 'S256',
    });
  });

  it('requires exact allowlisted redirect and authenticated context for linking', async () => {
    const transactions = createFakeOidcTransactionStore();
    const base = {
      configuration: oidcConfiguration,
      clock,
      secrets: secrets(),
      pkce: webCryptoPkce,
      transactions,
    } as const;
    await expect(
      startGoogleOidc({
        ...base,
        redirectUri: oidcFixture.otherRedirectUri,
        intent: 'sign-in',
      }),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'authentication-unavailable',
    });
    await expect(
      startGoogleOidc({
        ...base,
        redirectUri: oidcFixture.redirectUri,
        intent: 'link-current-account',
      }),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'authentication-unavailable',
    });
    const linked = await startGoogleOidc({
      ...base,
      redirectUri: oidcFixture.redirectUri,
      intent: 'link-current-account',
      vaultContext: {
        accountId: sessionFixtureIds.accountId,
        vaultId: sessionFixtureIds.vaultId,
        sessionId: sessionFixtureIds.sessionId,
        sessionEpoch: sessionFixtureIds.epoch,
      },
    });
    expect(linked.kind).toBe('redirect');
  });
});

describe('Google OIDC completion boundary', () => {
  it('resolves issuer plus subject and consumes the transaction exactly once', async () => {
    const { transactions } = await startedTransaction();
    const provider = createFakeOidcProvider(
      new Map([[oidcFixture.code, fixtureOidcClaims()]]),
    );
    const input = {
      callback: { state: oidcFixture.state, code: oidcFixture.code },
      configuration: oidcConfiguration,
      clock,
      transactions,
      provider,
      identities: createFakeOidcIdentityDirectory({
        identities: [oidcIdentityRecord],
      }),
    } as const;
    await expect(completeGoogleOidc(input)).resolves.toEqual({
      kind: 'resolved',
      resolution: {
        kind: 'authenticate-existing',
        identity: oidcIdentityRecord,
      },
    });
    expect(provider.exchanges()).toHaveLength(1);
    expect(provider.exchanges()[0]).toEqual({
      code: oidcFixture.code,
      clientId: oidcFixture.clientId,
      redirectUri: oidcFixture.redirectUri,
      codeVerifier: oidcFixture.verifier,
    });
    expect(transactions.remaining()).toBe(0);
    await expect(completeGoogleOidc(input)).resolves.toEqual({
      kind: 'failed',
      error: 'authentication-failed',
    });
    expect(provider.exchanges()).toHaveLength(1);
  });

  it.each([
    ['nonce', fixtureOidcClaims({ nonce: oidcFixture.otherNonce })],
    ['issuer', fixtureOidcClaims({ iss: oidcFixture.otherIssuer })],
    ['audience', fixtureOidcClaims({ aud: oidcFixture.otherClientId })],
    ['expiry', fixtureOidcClaims({ exp: 1_500 })],
    ['unverified email', fixtureOidcClaims({ email_verified: false })],
  ])(
    'maps invalid %s claims to the same generic error',
    async (_name, claims) => {
      const { transactions } = await startedTransaction();
      await expect(
        completeGoogleOidc({
          callback: { state: oidcFixture.state, code: oidcFixture.code },
          configuration: oidcConfiguration,
          clock,
          transactions,
          provider: createFakeOidcProvider(
            new Map([[oidcFixture.code, claims]]),
          ),
          identities: createFakeOidcIdentityDirectory(),
        }),
      ).resolves.toEqual({
        kind: 'failed',
        error: 'authentication-failed',
      });
      expect(transactions.remaining()).toBe(0);
    },
  );

  it('does not auto-link an email collision and does not expose the reason', async () => {
    const { transactions } = await startedTransaction();
    const emailAccounts = new Map([
      [oidcFixture.email, sessionFixtureIds.accountId],
    ]);
    await expect(
      completeGoogleOidc({
        callback: { state: oidcFixture.state, code: oidcFixture.code },
        configuration: oidcConfiguration,
        clock,
        transactions,
        provider: createFakeOidcProvider(
          new Map([[oidcFixture.code, fixtureOidcClaims()]]),
        ),
        identities: createFakeOidcIdentityDirectory({ emailAccounts }),
      }),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'authentication-failed',
    });
  });

  it('consumes provider denial without exchanging a code', async () => {
    const { transactions } = await startedTransaction();
    const provider = createFakeOidcProvider(new Map());
    await expect(
      completeGoogleOidc({
        callback: { state: oidcFixture.state, error: 'access_denied' },
        configuration: oidcConfiguration,
        clock,
        transactions,
        provider,
        identities: createFakeOidcIdentityDirectory(),
      }),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'authentication-failed',
    });
    expect(provider.exchanges()).toHaveLength(0);
    expect(transactions.remaining()).toBe(0);
  });

  it('rejects malformed directory values and duplicate callback parameters', async () => {
    const callbackUrl = `https://notes.example/auth/google/callback?state=${oidcFixture.state}&state=${oidcFixture.otherState}&code=${oidcFixture.code}`;
    expect(oidcCallbackInputFromUrl(callbackUrl)).toBeNull();

    const { transactions } = await startedTransaction();
    const identities: OidcIdentityDirectory = {
      findByIssuerSubject: vi.fn(async () => ({ accountId: 'not-enough' })),
      findAccountIdByVerifiedEmail: vi.fn(async () => undefined),
    };
    await expect(
      completeGoogleOidc({
        callback: { state: oidcFixture.state, code: oidcFixture.code },
        configuration: oidcConfiguration,
        clock,
        transactions,
        provider: createFakeOidcProvider(
          new Map([[oidcFixture.code, fixtureOidcClaims()]]),
        ),
        identities,
      }),
    ).resolves.toEqual({
      kind: 'failed',
      error: 'authentication-failed',
    });
  });
});
