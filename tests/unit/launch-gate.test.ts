import { describe, expect, it } from 'vitest';
import {
  decideLaunchAccess,
  launchGateIsEnforced,
  parseLaunchUserId,
} from '@/server/launch-gate/core';

describe('Production Launch Gate policy', () => {
  it.each([
    [false, false, false],
    [false, true, true],
    [true, false, true],
    [true, true, true],
  ])(
    'evaluates public=%s and allowed=%s as canAccess=%s',
    (publicAccessEnabled, userAllowed, canAccess) => {
      expect(decideLaunchAccess({ publicAccessEnabled, userAllowed })).toEqual({
        publicAccessEnabled,
        userAllowed,
        canAccess,
      });
    },
  );

  it('enforces in production and for unknown modes but bypasses development and tests', () => {
    expect(launchGateIsEnforced('production')).toBe(true);
    expect(launchGateIsEnforced(undefined)).toBe(true);
    expect(launchGateIsEnforced('unexpected')).toBe(true);
    expect(launchGateIsEnforced('development')).toBe(false);
    expect(launchGateIsEnforced('test')).toBe(false);
  });

  it('accepts opaque authenticated IDs without assuming an email or UUID format', () => {
    expect(parseLaunchUserId('sites-user_42')).toBe('sites-user_42');
    expect(parseLaunchUserId('')).toBeUndefined();
    expect(parseLaunchUserId(' padded ')).toBeUndefined();
    expect(parseLaunchUserId(`bad\nvalue`)).toBeUndefined();
    expect(parseLaunchUserId('x'.repeat(257))).toBeUndefined();
    expect(parseLaunchUserId(null)).toBeUndefined();
  });
});
