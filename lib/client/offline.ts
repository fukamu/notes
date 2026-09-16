import type { OfflineAppPort } from '@/lib/application/notes-runtime';
import { fullNetworkLayoutWorkerUrl } from '@/lib/client/full-network-layout-worker-url';

export async function prepareOfflineApp(): Promise<void> {
  const controller = await ensureServiceWorkerController();
  if (!controller) return;

  const resources = performance
    .getEntriesByType('resource')
    .map((entry) => entry.name)
    .filter((value) => {
      const url = new URL(value);
      return (
        url.origin === location.origin &&
        !url.pathname.startsWith('/api/') &&
        !url.pathname.startsWith('/__')
      );
    });
  resources.push(
    '/',
    '/manifest.webmanifest',
    '/favicon.svg',
    fullNetworkLayoutWorkerUrl,
  );

  await sendWorkerCommand(
    controller,
    { type: 'CACHE_URLS', urls: [...new Set(resources)] },
    'CACHE_URLS_RESULT',
    'ready',
  );
  document.documentElement.dataset.offlineReady = 'true';
}

export async function purgeOfflineAppCache(): Promise<void> {
  const controller = await ensureServiceWorkerController();
  if (!controller) return;
  await sendWorkerCommand(
    controller,
    { type: 'LOGOUT_CACHE_PURGE' },
    'LOGOUT_CACHE_PURGE_RESULT',
    'purged',
  );
}

async function ensureServiceWorkerController(): Promise<ServiceWorker | null> {
  if (!('serviceWorker' in navigator)) return null;
  await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  if (!navigator.serviceWorker.controller) {
    await new Promise<void>((resolve) => {
      navigator.serviceWorker.addEventListener(
        'controllerchange',
        () => resolve(),
        { once: true },
      );
    });
  }
  const controller = navigator.serviceWorker.controller;
  if (!controller) throw new Error('Service Worker did not take control');
  return controller;
}

function sendWorkerCommand(
  controller: ServiceWorker,
  command: unknown,
  expectedType: string,
  expectedStatus: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const channel = new MessageChannel();
    let complete = false;
    const finish = (result: { kind: 'resolve' } | { kind: 'reject' }) => {
      if (complete) return;
      complete = true;
      window.clearTimeout(timeout);
      channel.port1.close();
      if (result.kind === 'resolve') resolve();
      else reject(new Error(`Service Worker ${expectedType} failed`));
    };
    const timeout = window.setTimeout(() => finish({ kind: 'reject' }), 8_000);
    channel.port1.onmessage = (event) => {
      const input: unknown = event.data;
      finish(
        isWorkerAcknowledgement(input, expectedType, expectedStatus)
          ? { kind: 'resolve' }
          : { kind: 'reject' },
      );
    };
    channel.port1.onmessageerror = () => finish({ kind: 'reject' });
    controller.postMessage(command, [channel.port2]);
  });
}

function isWorkerAcknowledgement(
  input: unknown,
  expectedType: string,
  expectedStatus: string,
): boolean {
  return (
    input !== null &&
    typeof input === 'object' &&
    'type' in input &&
    input.type === expectedType &&
    'status' in input &&
    input.status === expectedStatus
  );
}

export const browserOfflineApp: OfflineAppPort = {
  prepare: prepareOfflineApp,
  purge: purgeOfflineAppCache,
};
