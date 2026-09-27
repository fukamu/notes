import { readFile } from 'node:fs/promises';

const serviceWorkerUrl = new URL('../dist/frontend/sw.js', import.meta.url);

let source;
try {
  source = await readFile(serviceWorkerUrl, 'utf8');
} catch (error) {
  throw new Error('Production build did not emit dist/frontend/sw.js', {
    cause: error,
  });
}

if (
  !source.includes("const CACHE_NAME = 'fukamu-notes-static-v4'") ||
  !source.includes("pathname.startsWith('/assets/')") ||
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
