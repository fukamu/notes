const CACHE_NAME = 'fukamu-notes-v2';
const APP_SHELL = ['/', '/manifest.webmanifest', '/favicon.svg'];

if (!isServiceWorkerScope(self)) {
  throw new Error('Service Worker loaded outside a ServiceWorkerGlobalScope');
}
const worker = self;

worker.addEventListener('install', (event) => {
  if (!(event instanceof ExtendableEvent)) return;
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)),
  );
  worker.skipWaiting();
});

worker.addEventListener('activate', (event) => {
  if (!(event instanceof ExtendableEvent)) return;
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
  worker.clients.claim();
});

worker.addEventListener('fetch', (event) => {
  if (!(event instanceof FetchEvent)) return;
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
  if (!(event instanceof ExtendableMessageEvent)) return;
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
 *
 * @param {unknown} data
 * @returns {string[] | undefined}
 */
function cacheUrlsFromMessage(data) {
  if (!data || typeof data !== 'object') return undefined;
  if (!('type' in data) || data.type !== 'CACHE_URLS') return undefined;
  if (!('urls' in data) || !Array.isArray(data.urls)) return undefined;

  return data.urls.filter((value) => {
    if (typeof value !== 'string') return false;
    try {
      const url = new URL(value, worker.location.origin);
      return (
        url.origin === worker.location.origin &&
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/__')
      );
    } catch {
      return false;
    }
  });
}

/**
 * @param {WorkerGlobalScope} scope
 * @returns {scope is ServiceWorkerGlobalScope}
 */
function isServiceWorkerScope(scope) {
  return (
    'skipWaiting' in scope &&
    typeof scope.skipWaiting === 'function' &&
    'clients' in scope &&
    typeof scope.clients === 'object'
  );
}
