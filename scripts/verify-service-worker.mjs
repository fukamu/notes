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
  !source.includes("const CACHE_NAME = 'fukamu-notes-static-v3'") ||
  !source.includes("pathname.startsWith('/_next/static/')") ||
  !source.includes("url.search !== ''") ||
  !source.includes("data.type === 'LOGOUT_CACHE_PURGE'") ||
  !source.includes("type: 'LOGOUT_CACHE_PURGE_RESULT'") ||
  !source.includes('deleteStaleNotesCaches') ||
  !source.includes("case 'network-only':")
) {
  throw new Error(
    'Production Service Worker is missing its static allowlist or purge guard',
  );
}
