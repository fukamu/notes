import { describe, expect, it, vi } from 'vitest';
import {
  CONNECTIONS_ZOOM_PREFERENCE_KEY,
  readConnectionsZoomPreference,
  writeConnectionsZoomPreference,
  type ConnectionsZoomPreferenceStorage,
} from '@/lib/client/connections-zoom-preference';

function memoryStorage(initialValue: string | null = null) {
  let value = initialValue;
  const storage: ConnectionsZoomPreferenceStorage = {
    getItem: () => value,
    setItem: (_key, nextValue) => {
      value = nextValue;
    },
  };
  return { storage, value: () => value };
}

describe('connections zoom preference adapter', () => {
  it('reads a valid scale and clamps finite out-of-range values', () => {
    expect(readConnectionsZoomPreference(memoryStorage('1.25').storage)).toBe(
      1.25,
    );
    expect(readConnectionsZoomPreference(memoryStorage('0.01').storage)).toBe(
      0.1,
    );
    expect(readConnectionsZoomPreference(memoryStorage('20').storage)).toBe(2);
  });

  it('rejects missing and corrupt values without throwing', () => {
    for (const value of [null, '', 'NaN', 'Infinity', 'not-a-scale']) {
      expect(
        readConnectionsZoomPreference(memoryStorage(value).storage),
      ).toBeNull();
    }
    const storage: ConnectionsZoomPreferenceStorage = {
      getItem: () => {
        throw new Error('storage unavailable');
      },
      setItem: vi.fn(),
    };
    expect(readConnectionsZoomPreference(storage)).toBeNull();
    expect(readConnectionsZoomPreference(null)).toBeNull();
  });

  it('writes only decoded scale values and contains storage failures', () => {
    const memory = memoryStorage();
    expect(writeConnectionsZoomPreference(memory.storage, 1.5)).toBe(true);
    expect(memory.value()).toBe('1.5');
    expect(writeConnectionsZoomPreference(memory.storage, 99)).toBe(true);
    expect(memory.value()).toBe('2');
    expect(writeConnectionsZoomPreference(memory.storage, Number.NaN)).toBe(
      false,
    );

    const setItem = vi.fn(() => {
      throw new Error('quota exceeded');
    });
    expect(
      writeConnectionsZoomPreference({ getItem: () => null, setItem }, 1.25),
    ).toBe(false);
    expect(setItem).toHaveBeenCalledWith(
      CONNECTIONS_ZOOM_PREFERENCE_KEY,
      '1.25',
    );
    expect(writeConnectionsZoomPreference(null, 1)).toBe(false);
  });
});
