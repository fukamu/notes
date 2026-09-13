import type { PkceChallengePort } from '../oidc-boundary';
import type { OidcAuthorizationRequest } from '../core/oidc';

export const webCryptoPkce: PkceChallengePort = {
  async deriveS256(verifier) {
    const digest = await crypto.subtle.digest(
      'SHA-256',
      new TextEncoder().encode(verifier),
    );
    return base64UrlEncode(new Uint8Array(digest));
  },
};

export function serializeOidcAuthorizationRequest(
  request: OidcAuthorizationRequest,
): string {
  const url = new URL(request.authorizationEndpoint);
  url.searchParams.set('response_type', request.responseType);
  url.searchParams.set('client_id', request.clientId);
  url.searchParams.set('redirect_uri', request.redirectUri);
  url.searchParams.set('scope', request.scope);
  url.searchParams.set('state', request.state);
  url.searchParams.set('nonce', request.nonce);
  url.searchParams.set('code_challenge', request.codeChallenge);
  url.searchParams.set('code_challenge_method', request.codeChallengeMethod);
  return url.toString();
}

export function oidcCallbackInputFromUrl(input: unknown): unknown {
  if (typeof input !== 'string' || input.length > 8_192) return null;
  try {
    const url = new URL(input);
    const output: Record<string, string> = {};
    for (const name of ['state', 'code', 'error', 'error_description']) {
      const values = url.searchParams.getAll(name);
      if (values.length > 1) return null;
      const value = values[0];
      if (value !== undefined) output[name] = value;
    }
    return output;
  } catch {
    return null;
  }
}

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');
}
