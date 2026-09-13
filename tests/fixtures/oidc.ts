import {
  parseOidcAuthorizationCode,
  parseOidcAuthorizationEndpoint,
  parseOidcClientId,
  parseOidcIssuer,
  parseOidcNonce,
  parseOidcRedirectUri,
  parseOidcState,
  parseOidcSubject,
  parseOidcEmailAddress,
  parsePkceCodeChallenge,
  parsePkceCodeVerifier,
} from '@/lib/domain/oidc';
import type {
  OidcIdentityRecord,
  OidcProviderConfiguration,
  PendingOidcTransaction,
} from '@/server/core/oidc';
import { sessionFixtureIds } from '@/tests/fixtures/session';

export const oidcFixture = {
  state: parseOidcState(`${'C'.repeat(42)}A`),
  otherState: parseOidcState(`${'E'.repeat(42)}A`),
  nonce: parseOidcNonce(`${'D'.repeat(42)}A`),
  otherNonce: parseOidcNonce(`${'F'.repeat(42)}A`),
  verifier: parsePkceCodeVerifier(
    'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk',
  ),
  challenge: parsePkceCodeChallenge(
    'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
  ),
  code: parseOidcAuthorizationCode('google-code-1'),
  issuer: parseOidcIssuer('https://accounts.google.com'),
  otherIssuer: parseOidcIssuer('https://issuer.example'),
  clientId: parseOidcClientId('fukamu-test.apps.googleusercontent.com'),
  otherClientId: parseOidcClientId('other.apps.googleusercontent.com'),
  authorizationEndpoint: parseOidcAuthorizationEndpoint(
    'https://accounts.google.com/o/oauth2/v2/auth',
  ),
  redirectUri: parseOidcRedirectUri(
    'https://notes.example/auth/google/callback',
  ),
  otherRedirectUri: parseOidcRedirectUri(
    'https://preview.notes.example/auth/google/callback',
  ),
  subject: parseOidcSubject('google-subject-123'),
  email: parseOidcEmailAddress('person@example.com'),
} as const;

export const oidcConfiguration: OidcProviderConfiguration = {
  authorizationEndpoint: oidcFixture.authorizationEndpoint,
  clientId: oidcFixture.clientId,
  allowedIssuers: [oidcFixture.issuer],
  redirectUris: [oidcFixture.redirectUri],
};

export function fixtureOidcTransaction(
  input: {
    readonly state?: typeof oidcFixture.state;
    readonly nonce?: typeof oidcFixture.nonce;
    readonly redirectUri?: typeof oidcFixture.redirectUri;
    readonly purpose?: PendingOidcTransaction['purpose'];
    readonly createdAtEpochSeconds?: number;
    readonly expiresAtEpochSeconds?: number;
  } = {},
): PendingOidcTransaction {
  return {
    state: input.state ?? oidcFixture.state,
    nonce: input.nonce ?? oidcFixture.nonce,
    codeVerifier: oidcFixture.verifier,
    redirectUri: input.redirectUri ?? oidcFixture.redirectUri,
    purpose: input.purpose ?? { kind: 'sign-in' },
    createdAtEpochSeconds: input.createdAtEpochSeconds ?? 1_000,
    expiresAtEpochSeconds: input.expiresAtEpochSeconds ?? 1_600,
  };
}

export function fixtureOidcClaims(
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    iss: oidcFixture.issuer,
    sub: oidcFixture.subject,
    aud: oidcFixture.clientId,
    exp: 2_000,
    iat: 1_000,
    nonce: oidcFixture.nonce,
    email: oidcFixture.email,
    email_verified: true,
    ...overrides,
  };
}

export const oidcIdentityRecord: OidcIdentityRecord = {
  identityId: sessionFixtureIds.identityId,
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  issuer: oidcFixture.issuer,
  subject: oidcFixture.subject,
};
