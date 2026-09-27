const CACHE_NAMESPACE = 'fukamu-notes-';
const CACHE_NAME = 'fukamu-notes-static-v4';
const APP_SHELL_PATH = '/';
const APP_SHELL_RESOURCES = [
  APP_SHELL_PATH,
  '/manifest.webmanifest',
  '/favicon.svg',
];
const STATIC_RESOURCE_PATHS = new Set([
  '/manifest.webmanifest',
  '/favicon.svg',
]);
const globalScope = globalThis;
if (!isServiceWorkerScope(globalScope)) {
  throw new Error('Service Worker loaded outside a ServiceWorkerGlobalScope');
}
const worker = globalScope;
worker.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL_RESOURCES)),
  );
  void worker.skipWaiting();
});
worker.addEventListener('activate', (event) => {
  event.waitUntil(deleteStaleNotesCaches().then(() => worker.clients.claim()));
});
worker.addEventListener('fetch', (event) => {
  const policy = cachePolicyForRequest(
    {
      method: event.request.method,
      url: event.request.url,
      mode: event.request.mode,
    },
    worker.location.origin,
  );
  switch (policy.kind) {
    case 'network-only':
      return;
    case 'immutable-static':
      event.respondWith(staticResponse(event.request));
      return;
    case 'app-shell-navigation':
      event.respondWith(appShellNavigationResponse(event.request));
      return;
  }
});
worker.addEventListener('message', (event) => {
  const command = workerCommandFromMessage(event.data);
  if (!command) return;
  event.waitUntil(handleWorkerCommand(command, event.ports[0]));
});
function cachePolicyForRequest(input, origin) {
  if (input.method !== 'GET') return { kind: 'network-only' };
  let url;
  try {
    url = new URL(input.url, origin);
  } catch {
    return { kind: 'network-only' };
  }
  if (url.origin !== origin || url.search !== '' || url.hash !== '') {
    return { kind: 'network-only' };
  }
  if (isStaticResourcePath(url.pathname)) {
    return { kind: 'immutable-static' };
  }
  if (input.mode === 'navigate' && isAppShellNavigationPath(url.pathname)) {
    return { kind: 'app-shell-navigation' };
  }
  return { kind: 'network-only' };
}
function isStaticResourcePath(pathname) {
  return STATIC_RESOURCE_PATHS.has(pathname) || pathname.startsWith('/assets/');
}
function isAppShellNavigationPath(pathname) {
  if (pathname === '/' || pathname === '/history') return true;
  return /^\/cards\/[^/]+(?:\/(?:history|connections))?$/.test(pathname);
}
async function staticResponse(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}
async function appShellNavigationResponse(request) {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const shell = await cache.match(APP_SHELL_PATH);
    if (shell) return shell;
    throw new Error('offline and no cached app shell');
  }
}
function workerCommandFromMessage(data) {
  if (!isRecord(data)) return undefined;
  if (data.type === 'CACHE_URLS') {
    const urls = cacheUrlsFromMessage(data);
    return urls ? { kind: 'cache-urls', urls } : undefined;
  }
  return data.type === 'LOGOUT_CACHE_PURGE'
    ? { kind: 'logout-cache-purge' }
    : undefined;
}
/** Only the non-personal shell and explicit static paths reach CacheStorage. */
function cacheUrlsFromMessage(data) {
  if (!isRecord(data) || data.type !== 'CACHE_URLS') return undefined;
  if (!isUnknownArray(data.urls)) return undefined;
  const urls = new Set();
  for (const value of data.urls) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value, worker.location.origin);
      if (
        url.origin === worker.location.origin &&
        url.search === '' &&
        url.hash === '' &&
        (url.pathname === APP_SHELL_PATH || isStaticResourcePath(url.pathname))
      ) {
        urls.add(url.pathname);
      }
    } catch {
      // Invalid URLs are untrusted input and are intentionally ignored.
    }
  }
  return [...urls];
}
async function handleWorkerCommand(command, replyPort) {
  switch (command.kind) {
    case 'cache-urls': {
      const cache = await caches.open(CACHE_NAME);
      const cached = await Promise.all(
        command.urls.map((url) =>
          url.startsWith('/assets/')
            ? cache.match(url).then((response) => Boolean(response))
            : Promise.resolve(false),
        ),
      );
      const toFetch = command.urls.filter((_, index) => !cached[index]);
      if (toFetch.length > 0) await cache.addAll(toFetch);
      replyPort?.postMessage({ type: 'CACHE_URLS_RESULT', status: 'ready' });
      return;
    }
    case 'logout-cache-purge':
      await purgeNotesCaches();
      replyPort?.postMessage({
        type: 'LOGOUT_CACHE_PURGE_RESULT',
        status: 'purged',
      });
      return;
  }
}
async function deleteStaleNotesCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(CACHE_NAMESPACE) && key !== CACHE_NAME)
      .map((key) => caches.delete(key)),
  );
  const remaining = (await caches.keys()).filter(
    (key) => key.startsWith(CACHE_NAMESPACE) && key !== CACHE_NAME,
  );
  if (remaining.length > 0) {
    throw new Error('stale FUKAMU cache deletion failed');
  }
}
async function purgeNotesCaches() {
  const keys = await caches.keys();
  await Promise.all(
    keys
      .filter((key) => key.startsWith(CACHE_NAMESPACE))
      .map((key) => caches.delete(key)),
  );
  const remaining = (await caches.keys()).filter((key) =>
    key.startsWith(CACHE_NAMESPACE),
  );
  if (remaining.length > 0) {
    throw new Error('FUKAMU cache purge did not complete');
  }
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
