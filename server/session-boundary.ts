import {
  sessionTokenDecoder,
  type SessionToken,
  type VaultContext,
} from '../lib/domain/identity';
import { evaluateCsrfRequest, type CsrfDecision } from './core/csrf';
import { SESSION_COOKIE_NAME } from './core/session-cookie';
import { authorizeSession, sessionRecordDecoder } from './core/session';

export type SessionCredentialResolver = {
  findSessionByToken: (token: SessionToken) => Promise<unknown>;
};

export type SessionRequestMetadata = {
  readonly method: unknown;
  readonly cookieHeader: unknown;
  readonly originHeader: unknown;
  readonly secFetchSiteHeader: unknown;
  readonly expectedOrigin: unknown;
  readonly now: number;
};

export type VaultContextResolution =
  | { readonly kind: 'authenticated'; readonly context: VaultContext }
  | {
      readonly kind: 'anonymous';
      readonly reason:
        | 'missing-session'
        | 'invalid-cookie'
        | 'unknown-session'
        | 'invalid-session-record'
        | 'revoked'
        | 'expired'
        | 'invalid-clock';
    }
  | { readonly kind: 'forbidden'; readonly csrf: CsrfDecision };

export async function deriveVaultContext(
  request: SessionRequestMetadata,
  resolver: SessionCredentialResolver,
): Promise<VaultContextResolution> {
  const csrf = evaluateCsrfRequest({
    method: request.method,
    expectedOrigin: request.expectedOrigin,
    originHeader: request.originHeader,
    secFetchSiteHeader: request.secFetchSiteHeader,
  });
  if (csrf.kind === 'denied') return { kind: 'forbidden', csrf };

  const cookie = sessionTokenFromCookieHeader(request.cookieHeader);
  if (cookie.kind === 'missing') {
    return { kind: 'anonymous', reason: 'missing-session' };
  }
  if (cookie.kind === 'invalid') {
    return { kind: 'anonymous', reason: 'invalid-cookie' };
  }

  const candidate: unknown = await resolver.findSessionByToken(cookie.token);
  if (candidate === undefined) {
    return { kind: 'anonymous', reason: 'unknown-session' };
  }
  const decoded = sessionRecordDecoder.decode(candidate);
  if (!decoded.ok) {
    return { kind: 'anonymous', reason: 'invalid-session-record' };
  }
  const access = authorizeSession(decoded.value, request.now);
  switch (access.kind) {
    case 'anonymous':
      return { kind: 'anonymous', reason: 'missing-session' };
    case 'denied':
      return { kind: 'anonymous', reason: access.reason };
    case 'authenticated':
      return access;
  }
}

type CookieTokenResult =
  | { readonly kind: 'missing' }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'found'; readonly token: SessionToken };

export function sessionTokenFromCookieHeader(
  header: unknown,
): CookieTokenResult {
  if (header === null || header === undefined || header === '') {
    return { kind: 'missing' };
  }
  if (typeof header !== 'string' || header.length > 8_192) {
    return { kind: 'invalid' };
  }

  const matches: string[] = [];
  for (const part of header.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (name === SESSION_COOKIE_NAME) {
      matches.push(part.slice(separator + 1).trim());
    }
  }
  if (matches.length === 0) return { kind: 'missing' };
  if (matches.length !== 1) return { kind: 'invalid' };
  const decoded = sessionTokenDecoder.decode(matches[0]);
  return decoded.ok
    ? { kind: 'found', token: decoded.value }
    : { kind: 'invalid' };
}
