const CACHE_NAMESPACE = 'fukamu-notes-';
const CACHE_NAME = 'fukamu-notes-static-v3';
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

type ExtendableWorkerEvent = {
  waitUntil(promise: Promise<unknown>): void;
};

type FetchWorkerEvent = ExtendableWorkerEvent & {
  request: Request;
  respondWith(response: Promise<Response> | Response): void;
};

type MessageWorkerEvent = ExtendableWorkerEvent & {
  data: unknown;
  ports: { postMessage(message: unknown): void }[];
};

type ServiceWorkerScope = {
  addEventListener(
    type: 'install' | 'activate',
    listener: (event: ExtendableWorkerEvent) => void,
  ): void;
  addEventListener(
    type: 'fetch',
    listener: (event: FetchWorkerEvent) => void,
  ): void;
  addEventListener(
    type: 'message',
    listener: (event: MessageWorkerEvent) => void,
  ): void;
  clients: { claim(): Promise<void> };
  location: { origin: string };
  skipWaiting(): Promise<void>;
};

type CacheRequestInput = {
  method: string;
  url: string;
  mode: string;
};

type CacheRequestPolicy =
  | { kind: 'network-only' }
  | { kind: 'immutable-static' }
  | { kind: 'app-shell-navigation' };

type WorkerCommand =
  | { kind: 'cache-urls'; urls: string[] }
  | { kind: 'logout-cache-purge' };

const globalScope: unknown = globalThis;
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

function cachePolicyForRequest(
  input: CacheRequestInput,
  origin: string,
): CacheRequestPolicy {
  if (input.method !== 'GET') return { kind: 'network-only' };
  let url: URL;
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

function isStaticResourcePath(pathname: string): boolean {
  return (
    STATIC_RESOURCE_PATHS.has(pathname) || pathname.startsWith('/_next/static/')
  );
}

function isAppShellNavigationPath(pathname: string): boolean {
  if (pathname === '/' || pathname === '/history') return true;
  return /^\/cards\/[^/]+(?:\/(?:history|connections))?$/.test(pathname);
}

async function staticResponse(request: Request): Promise<Response> {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request, response.clone());
  return response;
}

async function appShellNavigationResponse(request: Request): Promise<Response> {
  try {
    return await fetch(request);
  } catch {
    const cache = await caches.open(CACHE_NAME);
    const shell = await cache.match(APP_SHELL_PATH);
    if (shell) return shell;
    throw new Error('offline and no cached app shell');
  }
}

function workerCommandFromMessage(data: unknown): WorkerCommand | undefined {
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
function cacheUrlsFromMessage(data: unknown): string[] | undefined {
  if (!isRecord(data) || data.type !== 'CACHE_URLS') return undefined;
  if (!isUnknownArray(data.urls)) return undefined;

  const urls = new Set<string>();
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

async function handleWorkerCommand(
  command: WorkerCommand,
  replyPort: { postMessage(message: unknown): void } | undefined,
): Promise<void> {
  switch (command.kind) {
    case 'cache-urls': {
      const cache = await caches.open(CACHE_NAME);
      await cache.addAll(command.urls);
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

async function deleteStaleNotesCaches(): Promise<void> {
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

async function purgeNotesCaches(): Promise<void> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

function isServiceWorkerScope(scope: unknown): scope is ServiceWorkerScope {
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
