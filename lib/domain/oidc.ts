import {
  decodeOrThrow,
  refineDecoder,
  stringDecoder,
  transformDecoder,
  type Decoder,
} from '../codec/core';

declare const oidcValueBrand: unique symbol;

type OidcValue<TName extends string> = string & {
  readonly [oidcValueBrand]: TName;
};

export type OidcState = OidcValue<'OidcState'>;
export type OidcNonce = OidcValue<'OidcNonce'>;
export type PkceCodeVerifier = OidcValue<'PkceCodeVerifier'>;
export type PkceCodeChallenge = OidcValue<'PkceCodeChallenge'>;
export type OidcAuthorizationCode = OidcValue<'OidcAuthorizationCode'>;
export type OidcIssuer = OidcValue<'OidcIssuer'>;
export type OidcSubject = OidcValue<'OidcSubject'>;
export type OidcClientId = OidcValue<'OidcClientId'>;
export type OidcAuthorizationEndpoint = OidcValue<'OidcAuthorizationEndpoint'>;
export type OidcRedirectUri = OidcValue<'OidcRedirectUri'>;
export type OidcEmailAddress = OidcValue<'OidcEmailAddress'>;

const canonicalBase64Url256Decoder = refineDecoder(
  stringDecoder({ minLength: 43, maxLength: 43 }),
  (value) => /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(value),
  'expected an unpadded 256-bit base64url value',
);

export const oidcStateDecoder: Decoder<OidcState> = transformDecoder(
  canonicalBase64Url256Decoder,
  (value) => value as OidcState,
);

export const oidcNonceDecoder: Decoder<OidcNonce> = transformDecoder(
  canonicalBase64Url256Decoder,
  (value) => value as OidcNonce,
);

export const pkceCodeVerifierDecoder: Decoder<PkceCodeVerifier> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 43, maxLength: 128 }),
      (value) => /^[A-Za-z0-9._~-]+$/.test(value),
      'expected an RFC 7636 code verifier',
    ),
    (value) => value as PkceCodeVerifier,
  );

export const pkceCodeChallengeDecoder: Decoder<PkceCodeChallenge> =
  transformDecoder(
    canonicalBase64Url256Decoder,
    (value) => value as PkceCodeChallenge,
  );

export const oidcAuthorizationCodeDecoder: Decoder<OidcAuthorizationCode> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 4_096 }),
      (value) => /^[\x21-\x7e]+$/.test(value),
      'expected a visible ASCII authorization code',
    ),
    (value) => value as OidcAuthorizationCode,
  );

function isHttpsUriWithoutCredentialsOrFragment(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

function isExactRedirectUri(value: string): boolean {
  if (/\s/.test(value)) return false;
  try {
    const url = new URL(value);
    const loopback =
      url.hostname === 'localhost' ||
      url.hostname === '127.0.0.1' ||
      url.hostname === '[::1]';
    return (
      (url.protocol === 'https:' || (url.protocol === 'http:' && loopback)) &&
      url.username === '' &&
      url.password === '' &&
      url.hash === ''
    );
  } catch {
    return false;
  }
}

export const oidcIssuerDecoder: Decoder<OidcIssuer> = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 1, maxLength: 2_048 }),
    (value) =>
      value === 'accounts.google.com' ||
      (isHttpsUriWithoutCredentialsOrFragment(value) && !value.includes('?')),
    'expected an HTTPS issuer or the exact Google legacy issuer',
  ),
  (value) => value as OidcIssuer,
);

export const oidcAuthorizationEndpointDecoder: Decoder<OidcAuthorizationEndpoint> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 2_048 }),
      (value) => isHttpsUriWithoutCredentialsOrFragment(value),
      'expected an HTTPS authorization endpoint',
    ),
    (value) => value as OidcAuthorizationEndpoint,
  );

export const oidcRedirectUriDecoder: Decoder<OidcRedirectUri> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 1, maxLength: 2_048 }),
      isExactRedirectUri,
      'expected an HTTPS or loopback HTTP redirect URI without credentials or fragment',
    ),
    (value) => value as OidcRedirectUri,
  );

export const oidcSubjectDecoder: Decoder<OidcSubject> = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 1, maxLength: 255 }),
    (value) => /^[\x21-\x7e]+$/.test(value),
    'expected a visible ASCII OIDC subject',
  ),
  (value) => value as OidcSubject,
);

export const oidcClientIdDecoder: Decoder<OidcClientId> = transformDecoder(
  refineDecoder(
    stringDecoder({ minLength: 1, maxLength: 512 }),
    (value) => /^[\x21-\x7e]+$/.test(value),
    'expected a visible ASCII OIDC client identifier',
  ),
  (value) => value as OidcClientId,
);

export const oidcEmailAddressDecoder: Decoder<OidcEmailAddress> =
  transformDecoder(
    refineDecoder(
      stringDecoder({ minLength: 3, maxLength: 320 }),
      (value) =>
        /^[\x21-\x7e]+$/.test(value) &&
        value.indexOf('@') > 0 &&
        value.lastIndexOf('@') === value.indexOf('@') &&
        value.indexOf('@') < value.length - 1,
      'expected a bounded ASCII email address',
    ),
    (value) => value as OidcEmailAddress,
  );

export function parseOidcState(input: unknown): OidcState {
  return decodeOrThrow(oidcStateDecoder, input, 'OidcState');
}

export function parseOidcNonce(input: unknown): OidcNonce {
  return decodeOrThrow(oidcNonceDecoder, input, 'OidcNonce');
}

export function parsePkceCodeVerifier(input: unknown): PkceCodeVerifier {
  return decodeOrThrow(pkceCodeVerifierDecoder, input, 'PkceCodeVerifier');
}

export function parsePkceCodeChallenge(input: unknown): PkceCodeChallenge {
  return decodeOrThrow(pkceCodeChallengeDecoder, input, 'PkceCodeChallenge');
}

export function parseOidcAuthorizationCode(
  input: unknown,
): OidcAuthorizationCode {
  return decodeOrThrow(
    oidcAuthorizationCodeDecoder,
    input,
    'OidcAuthorizationCode',
  );
}

export function parseOidcIssuer(input: unknown): OidcIssuer {
  return decodeOrThrow(oidcIssuerDecoder, input, 'OidcIssuer');
}

export function parseOidcClientId(input: unknown): OidcClientId {
  return decodeOrThrow(oidcClientIdDecoder, input, 'OidcClientId');
}

export function parseOidcAuthorizationEndpoint(
  input: unknown,
): OidcAuthorizationEndpoint {
  return decodeOrThrow(
    oidcAuthorizationEndpointDecoder,
    input,
    'OidcAuthorizationEndpoint',
  );
}

export function parseOidcRedirectUri(input: unknown): OidcRedirectUri {
  return decodeOrThrow(oidcRedirectUriDecoder, input, 'OidcRedirectUri');
}

export function parseOidcSubject(input: unknown): OidcSubject {
  return decodeOrThrow(oidcSubjectDecoder, input, 'OidcSubject');
}

export function parseOidcEmailAddress(input: unknown): OidcEmailAddress {
  return decodeOrThrow(oidcEmailAddressDecoder, input, 'OidcEmailAddress');
}
