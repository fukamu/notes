import { describe, expect, it } from 'vitest';
import { resolveAuthEntryUrl } from '@/app/(notes)/production-launch-gate';

describe('static frontend auth entry configuration', () => {
  it('keeps sign-in unavailable until a same-origin entry is configured', () => {
    expect(resolveAuthEntryUrl(undefined)).toBeUndefined();
    expect(resolveAuthEntryUrl('')).toBeUndefined();
    expect(resolveAuthEntryUrl('/auth/login?return_to=%2F')).toBe(
      '/auth/login?return_to=%2F',
    );
  });

  it.each([
    'https://identity.example/login',
    '//identity.example/login',
    'auth/login',
    '/auth\\login',
    '/auth/login\nnext',
  ])('rejects an unsafe auth entry: %s', (value) => {
    expect(() => resolveAuthEntryUrl(value)).toThrow(
      'FUKAMU_AUTH_ENTRY_URL must be a same-origin absolute path',
    );
  });
});
