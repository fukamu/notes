import { describe, expect, it } from 'vitest';
import {
  clearOfflineLaunchAdmission,
  hasOfflineLaunchAdmission,
  rememberOfflineLaunchAdmission,
} from '@/lib/client/production-launch-admission';

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
}

describe('production launch offline admission', () => {
  it('is tab-local state that logout can clear', () => {
    const storage = memoryStorage();
    expect(hasOfflineLaunchAdmission(storage)).toBe(false);
    rememberOfflineLaunchAdmission(storage);
    expect(hasOfflineLaunchAdmission(storage)).toBe(true);
    clearOfflineLaunchAdmission(storage);
    expect(hasOfflineLaunchAdmission(storage)).toBe(false);
  });

  it('fails closed when browser storage is unavailable', () => {
    const unavailable = {
      getItem() {
        throw new Error('blocked');
      },
      setItem() {
        throw new Error('blocked');
      },
      removeItem() {
        throw new Error('blocked');
      },
    };
    rememberOfflineLaunchAdmission(unavailable);
    clearOfflineLaunchAdmission(unavailable);
    expect(hasOfflineLaunchAdmission(unavailable)).toBe(false);
  });
});
