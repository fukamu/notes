import { describe, expect, it } from 'vitest';
import { ConfigurationError, getD1Binding } from '@/db/environment';
import {
  resolveSiteUrl,
  SiteUrlConfigurationError,
} from '@/lib/environment/site-url';

describe('environment boundaries', () => {
  it('accepts only a D1-shaped DB binding', () => {
    const database = {
      batch: () => Promise.resolve([]),
      exec: () => Promise.resolve({ count: 0, duration: 0 }),
      prepare: () => ({}),
    };
    expect(getD1Binding({ DB: database })).toBe(database);
    for (const value of [undefined, null, {}, { DB: {} }, { DB: 'remote' }]) {
      expect(() => getD1Binding(value)).toThrow(ConfigurationError);
    }
  });

  it('parses absolute HTTP(S) site URLs and rejects invalid configuration', () => {
    expect(resolveSiteUrl(undefined).protocol).toBe('https:');
    expect(resolveSiteUrl('https://notes.example/base').href).toBe(
      'https://notes.example/base',
    );
    expect(resolveSiteUrl('http://localhost:3100').origin).toBe(
      'http://localhost:3100',
    );
    for (const value of [42, '/relative', 'file:///tmp/site', 'not a url']) {
      expect(() => resolveSiteUrl(value)).toThrow(SiteUrlConfigurationError);
    }
  });
});
