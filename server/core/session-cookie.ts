import type { SessionToken } from '../../lib/domain/identity';

export const SESSION_COOKIE_NAME = '__Host-fukamu_session';

export type SessionCookieInstruction =
  | {
      readonly kind: 'set';
      readonly name: typeof SESSION_COOKIE_NAME;
      readonly value: SessionToken;
      readonly path: '/';
      readonly secure: true;
      readonly httpOnly: true;
      readonly sameSite: 'strict';
      readonly maxAgeSeconds: number;
    }
  | {
      readonly kind: 'clear';
      readonly name: typeof SESSION_COOKIE_NAME;
      readonly value: '';
      readonly path: '/';
      readonly secure: true;
      readonly httpOnly: true;
      readonly sameSite: 'strict';
      readonly maxAgeSeconds: 0;
    };

export type SessionCookieDecision =
  | {
      readonly kind: 'accepted';
      readonly instruction: SessionCookieInstruction;
    }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-max-age' };

export function setSessionCookie(
  token: SessionToken,
  maxAgeSeconds: number,
): SessionCookieDecision {
  if (
    !Number.isSafeInteger(maxAgeSeconds) ||
    maxAgeSeconds < 1 ||
    maxAgeSeconds > 2_592_000
  ) {
    return { kind: 'rejected', reason: 'invalid-max-age' };
  }
  return {
    kind: 'accepted',
    instruction: {
      kind: 'set',
      name: SESSION_COOKIE_NAME,
      value: token,
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'strict',
      maxAgeSeconds,
    },
  };
}

export function clearSessionCookie(): SessionCookieInstruction {
  return {
    kind: 'clear',
    name: SESSION_COOKIE_NAME,
    value: '',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'strict',
    maxAgeSeconds: 0,
  };
}
