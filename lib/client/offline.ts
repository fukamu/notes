import { prepareConnectionsLayoutWorker } from '@/lib/client/connections-layout-worker';
import { connectionsLayoutWorkerUrl } from '@/lib/client/connections-layout-worker-url';

export async function prepareOfflineApp(): Promise<void> {
  if (!('serviceWorker' in navigator)) return;
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
    location.href,
    '/manifest.webmanifest',
    '/favicon.svg',
    connectionsLayoutWorkerUrl,
  );

  await new Promise<void>((resolve) => {
    const channel = new MessageChannel();
    const timeout = window.setTimeout(resolve, 8_000);
    channel.port1.onmessage = () => {
      window.clearTimeout(timeout);
      resolve();
    };
    navigator.serviceWorker.controller?.postMessage(
      { type: 'CACHE_URLS', urls: [...new Set(resources)] },
      [channel.port2],
    );
  });
  await prepareConnectionsLayoutWorker();
  document.documentElement.dataset.offlineReady = 'true';
}
