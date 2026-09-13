export type ServiceRuntimeMode = 'legacy-test' | 'public-paid';

export type ServiceRuntimeModeResolution =
  | { readonly kind: 'configured'; readonly mode: ServiceRuntimeMode }
  | { readonly kind: 'invalid' };

export function resolveServiceRuntimeMode(
  environment: unknown,
): ServiceRuntimeModeResolution {
  if (!environment || typeof environment !== 'object') {
    return { kind: 'invalid' };
  }
  const value: unknown = Reflect.get(environment, 'FUKAMU_SERVICE_MODE');
  if (value === undefined) {
    // Existing Sites/local environments predate the public paid mode. Keeping
    // their absent binding in legacy mode preserves local-first development;
    // production activation must explicitly select public-paid.
    return { kind: 'configured', mode: 'legacy-test' };
  }
  return value === 'legacy-test' || value === 'public-paid'
    ? { kind: 'configured', mode: value }
    : { kind: 'invalid' };
}

export function legacySyncIsEnabled(environment: unknown): boolean {
  const resolution = resolveServiceRuntimeMode(environment);
  return resolution.kind === 'configured' && resolution.mode === 'legacy-test';
}
