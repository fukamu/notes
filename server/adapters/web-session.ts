import type { SessionCookieInstruction } from '../core/session-cookie';
import type { SessionRequestMetadata } from '../session-boundary';

export function sessionMetadataFromRequest(
  request: Request,
  input: { readonly expectedOrigin: unknown; readonly now: number },
): SessionRequestMetadata {
  return {
    method: request.method,
    cookieHeader: request.headers.get('cookie'),
    originHeader: request.headers.get('origin'),
    secFetchSiteHeader: request.headers.get('sec-fetch-site'),
    expectedOrigin: input.expectedOrigin,
    now: input.now,
  };
}

export function serializeSessionCookie(
  instruction: SessionCookieInstruction,
): string {
  return [
    `${instruction.name}=${instruction.value}`,
    `Path=${instruction.path}`,
    `Max-Age=${instruction.maxAgeSeconds}`,
    'Secure',
    'HttpOnly',
    'SameSite=Strict',
  ].join('; ');
}
