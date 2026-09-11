const CACHE_NAME = 'fukamu-notes-v2';
const APP_SHELL = ['/', '/manifest.webmanifest', '/favicon.svg'];
const globalScope = globalThis;
if (!isServiceWorkerScope(globalScope)) {
  throw new Error('Service Worker loaded outside a ServiceWorkerGlobalScope');
}
const worker = globalScope;
worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  void worker.skipWaiting();
});
worker.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== CACHE_NAME)
            .map((key) => caches.delete(key)),
        ),
      ),
  );
  void worker.clients.claim();
});
worker.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== worker.location.origin || url.pathname.startsWith('/api/'))
    return;
  event.respondWith(
    fetch(request)
      .then(async (response) => {
        if (response.ok) {
          const copy = response.clone();
          const cache = await caches.open(CACHE_NAME);
          await cache.put(request, copy);
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === 'navigate') {
          const shell = await caches.match('/');
          if (shell) return shell;
        }
        throw new Error('offline and no cached response');
      }),
  );
});
worker.addEventListener('message', (event) => {
  const urls = cacheUrlsFromMessage(event.data);
  if (!urls) return;
  const replyPort = event.ports[0];
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => Promise.allSettled(urls.map((url) => cache.add(url))))
      .then(() => replyPort?.postMessage({ ready: true })),
  );
});
/**
 * Treats cross-context message data as untrusted. Only the documented message
 * shape and string URLs from this origin can reach CacheStorage.
 */
function cacheUrlsFromMessage(data) {
  if (!isRecord(data) || data.type !== 'CACHE_URLS') return undefined;
  if (!isUnknownArray(data.urls)) return undefined;
  const urls = [];
  for (const value of data.urls) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value, worker.location.origin);
      if (
        url.origin === worker.location.origin &&
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/__')
      ) {
        urls.push(value);
      }
    } catch {
      // Invalid URLs are untrusted input and are intentionally ignored.
    }
  }
  return urls;
}
function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function isUnknownArray(value) {
  return Array.isArray(value);
}
function isServiceWorkerScope(scope) {
  return (
    scope !== null &&
    typeof scope === 'object' &&
    'addEventListener' in scope &&
    typeof scope.addEventListener === 'function' &&
    'skipWaiting' in scope &&
    typeof scope.skipWaiting === 'function' &&
    'clients' in scope &&
    typeof scope.clients === 'object'
  );
}
