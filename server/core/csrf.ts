const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfDecision =
  | { readonly kind: 'allowed'; readonly reason: 'safe-method' | 'same-origin' }
  | {
      readonly kind: 'denied';
      readonly reason:
        | 'invalid-method'
        | 'invalid-expected-origin'
        | 'missing-origin'
        | 'origin-mismatch'
        | 'missing-fetch-metadata'
        | 'cross-site';
    };

export function evaluateCsrfRequest(input: {
  readonly method: unknown;
  readonly expectedOrigin: unknown;
  readonly originHeader: unknown;
  readonly secFetchSiteHeader: unknown;
}): CsrfDecision {
  if (typeof input.method !== 'string' || !/^[A-Z]+$/.test(input.method)) {
    return { kind: 'denied', reason: 'invalid-method' };
  }
  if (SAFE_METHODS.has(input.method)) {
    return { kind: 'allowed', reason: 'safe-method' };
  }

  const expectedOrigin = strictOrigin(input.expectedOrigin);
  if (!expectedOrigin) {
    return { kind: 'denied', reason: 'invalid-expected-origin' };
  }
  const requestOrigin = strictOrigin(input.originHeader);
  if (!requestOrigin) return { kind: 'denied', reason: 'missing-origin' };
  if (requestOrigin !== expectedOrigin) {
    return { kind: 'denied', reason: 'origin-mismatch' };
  }
  if (input.secFetchSiteHeader === null) {
    return { kind: 'denied', reason: 'missing-fetch-metadata' };
  }
  return input.secFetchSiteHeader === 'same-origin'
    ? { kind: 'allowed', reason: 'same-origin' }
    : { kind: 'denied', reason: 'cross-site' };
}

function strictOrigin(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length > 2_048) return undefined;
  try {
    const url = new URL(value);
    return url.origin === value ? url.origin : undefined;
  } catch {
    return undefined;
  }
}
