'use client';

import type { LogoutPurgeTargetResult } from '@/lib/application/logout-purge-runner';

const CACHE_NAMESPACE = 'fukamu-notes-';

export type ServiceWorkerLogoutCachePlatformResult =
  | { readonly kind: 'received'; readonly acknowledgement: unknown }
  | {
      readonly kind: 'failed';
      readonly reason: 'timeout' | 'adapter-failure' | 'unsupported-capability';
    };

export type ServiceWorkerLogoutCachePlatform = {
  requestPurge: (
    timeoutMs: number,
  ) => Promise<ServiceWorkerLogoutCachePlatformResult>;
  readCacheNames: () => Promise<unknown>;
};

export function createServiceWorkerLogoutCachePurge(
  platform: ServiceWorkerLogoutCachePlatform,
  timeoutMs: number,
): () => Promise<LogoutPurgeTargetResult> {
  return async () => {
    try {
      if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
        return { kind: 'failed', reason: 'adapter-failure' };
      }
      const result = await platform.requestPurge(timeoutMs);
      if (result.kind === 'failed') return result;
      if (!isPurgeAcknowledgement(result.acknowledgement)) {
        return { kind: 'failed', reason: 'verification-failed' };
      }
      return verifyServiceWorkerCaches(await platform.readCacheNames());
    } catch {
      return { kind: 'failed', reason: 'adapter-failure' };
    }
  };
}

export function verifyServiceWorkerCaches(
  input: unknown,
): LogoutPurgeTargetResult {
  if (
    !Array.isArray(input) ||
    !input.every((value) => typeof value === 'string')
  ) {
    return { kind: 'failed', reason: 'verification-failed' };
  }
  return input.some((name) => name.startsWith(CACHE_NAMESPACE))
    ? { kind: 'failed', reason: 'verification-failed' }
    : { kind: 'completed' };
}

export async function verifyBrowserServiceWorkerCaches(): Promise<LogoutPurgeTargetResult> {
  const cacheStorage: unknown = globalThis.caches;
  if (!isCacheStorage(cacheStorage)) {
    return { kind: 'failed', reason: 'unsupported-capability' };
  }
  try {
    const names: unknown = await cacheStorage.keys();
    return verifyServiceWorkerCaches(names);
  } catch {
    return { kind: 'failed', reason: 'adapter-failure' };
  }
}

export const browserServiceWorkerLogoutCachePlatform: ServiceWorkerLogoutCachePlatform =
  {
    requestPurge: requestBrowserServiceWorkerPurge,
    async readCacheNames() {
      const cacheStorage: unknown = globalThis.caches;
      if (!isCacheStorage(cacheStorage)) {
        throw new Error('CacheStorage is unavailable');
      }
      const names: unknown = await cacheStorage.keys();
      return names;
    },
  };

async function requestBrowserServiceWorkerPurge(
  timeoutMs: number,
): Promise<ServiceWorkerLogoutCachePlatformResult> {
  const serviceWorkerContainer: unknown = navigator.serviceWorker;
  if (
    !isServiceWorkerContainer(serviceWorkerContainer) ||
    typeof globalThis.MessageChannel !== 'function'
  ) {
    return { kind: 'failed', reason: 'unsupported-capability' };
  }
  const controller: unknown = serviceWorkerContainer.controller;
  if (!isServiceWorkerController(controller)) {
    return { kind: 'failed', reason: 'unsupported-capability' };
  }

  let channel: MessageChannel;
  try {
    channel = new MessageChannel();
  } catch {
    return { kind: 'failed', reason: 'adapter-failure' };
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ServiceWorkerLogoutCachePlatformResult) => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timer);
      channel.port1.close();
      resolve(result);
    };
    const timer = window.setTimeout(
      () => finish({ kind: 'failed', reason: 'timeout' }),
      timeoutMs,
    );
    channel.port1.onmessage = (event) => {
      const acknowledgement: unknown = event.data;
      finish({ kind: 'received', acknowledgement });
    };
    channel.port1.onmessageerror = () =>
      finish({ kind: 'failed', reason: 'adapter-failure' });
    try {
      controller.postMessage({ type: 'LOGOUT_CACHE_PURGE' }, [channel.port2]);
    } catch {
      finish({ kind: 'failed', reason: 'adapter-failure' });
    }
  });
}

function isPurgeAcknowledgement(input: unknown): boolean {
  return (
    isRecord(input) &&
    input.type === 'LOGOUT_CACHE_PURGE_RESULT' &&
    input.status === 'purged'
  );
}

function isServiceWorkerContainer(
  input: unknown,
): input is { readonly controller: unknown } {
  return isRecord(input) && 'controller' in input;
}

function isServiceWorkerController(
  input: unknown,
): input is { postMessage(message: unknown, transfer: Transferable[]): void } {
  return isRecord(input) && typeof input.postMessage === 'function';
}

function isCacheStorage(input: unknown): input is { keys(): Promise<unknown> } {
  return isRecord(input) && typeof input.keys === 'function';
}

function isRecord(input: unknown): input is Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input);
}
