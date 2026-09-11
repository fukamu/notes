import { readFile } from 'node:fs/promises';

const serviceWorkerUrl = new URL('../dist/client/sw.js', import.meta.url);

let source;
try {
  source = await readFile(serviceWorkerUrl, 'utf8');
} catch (error) {
  throw new Error('Production build did not emit dist/client/sw.js', {
    cause: error,
  });
}

if (
  !source.includes("data.type !== 'CACHE_URLS'") ||
  !source.includes("typeof value !== 'string'") ||
  !source.includes('url.origin === worker.location.origin')
) {
  throw new Error('Production Service Worker is missing the CACHE_URLS guard');
}
