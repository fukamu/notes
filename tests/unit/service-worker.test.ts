import { readFile } from 'node:fs/promises';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

type CacheMessageParser = (data: unknown) => string[] | undefined;

async function loadCacheMessageParser(): Promise<CacheMessageParser> {
  const source = await readFile(
    new URL('../../public/sw.js', import.meta.url),
    'utf8',
  );
  const context = createContext({
    URL,
    self: {
      addEventListener: () => undefined,
      clients: {},
      location: { origin: 'https://notes.example' },
      skipWaiting: () => undefined,
    },
  });
  runInContext(
    `${source}\nglobalThis.__cacheUrlsFromMessage = cacheUrlsFromMessage;`,
    context,
  );
  const parser: unknown = context.__cacheUrlsFromMessage;
  if (typeof parser !== 'function') {
    throw new Error('Service Worker did not define its message parser');
  }
  // The runtime guard above proves the VM boundary value is callable. Its
  // behavior and return shape are exercised below with untrusted inputs.
  return parser as CacheMessageParser;
}

describe('Service Worker CACHE_URLS boundary', () => {
  it('ignores non-objects, wrong message types, and non-array URL fields', async () => {
    const parse = await loadCacheMessageParser();
    for (const value of [
      null,
      'CACHE_URLS',
      7,
      {},
      { type: 'WRONG', urls: ['/'] },
      { type: 'CACHE_URLS', urls: '/' },
    ]) {
      expect(parse(value)).toBeUndefined();
    }
  });

  it('passes only same-origin, non-internal string URLs to CacheStorage', async () => {
    const parse = await loadCacheMessageParser();
    expect(
      parse({
        type: 'CACHE_URLS',
        urls: [
          '/',
          '/cards/example',
          42,
          null,
          'https://other.example/card',
          '/api/sync',
          '/__vinext/client',
          'http://[invalid',
        ],
      }),
    ).toEqual(['/', '/cards/example']);
  });
});
