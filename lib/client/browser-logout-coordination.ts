import {
  parseTabInstanceId,
  type LogoutCoordinationMessage,
  type TabInstanceId,
} from '@/lib/application/logout-coordination';
import type {
  LogoutCoordinationChannelPort,
  LogoutCoordinationLockRequest,
  LogoutCoordinationLockResult,
  LogoutCoordinationPlatformPort,
} from '@/lib/application/logout-runtime-coordination';

export function createBrowserTabInstanceId(): TabInstanceId {
  return parseTabInstanceId(crypto.randomUUID());
}

export function createBrowserLogoutCoordinationPlatform(): LogoutCoordinationPlatformPort {
  return {
    openChannel(name) {
      if (typeof BroadcastChannel !== 'function') {
        return { kind: 'failed', reason: 'unsupported-capability' };
      }
      try {
        const channel = new BroadcastChannel(name);
        return {
          kind: 'opened',
          channel: browserChannel(channel),
        };
      } catch {
        return { kind: 'failed', reason: 'adapter-failure' };
      }
    },
    acquireLock(request) {
      if (typeof navigator === 'undefined') {
        return Promise.resolve({
          kind: 'failed',
          reason: 'unsupported-capability',
        });
      }
      const lockManager: unknown = navigator.locks;
      if (!isBrowserLockManager(lockManager)) {
        return Promise.resolve({
          kind: 'failed',
          reason: 'unsupported-capability',
        });
      }
      return acquireBrowserLock(lockManager, request);
    },
  };
}

function browserChannel(
  channel: BroadcastChannel,
): LogoutCoordinationChannelPort {
  return {
    post(message: LogoutCoordinationMessage) {
      try {
        channel.postMessage(message);
        return 'sent';
      } catch {
        return 'failed';
      }
    },
    subscribe(listener) {
      const handleMessage = (event: MessageEvent<unknown>) =>
        listener(event.data);
      channel.addEventListener('message', handleMessage);
      return () => channel.removeEventListener('message', handleMessage);
    },
    close: () => channel.close(),
  };
}

type BrowserLockManager = Pick<LockManager, 'request'>;

function isBrowserLockManager(input: unknown): input is BrowserLockManager {
  return (
    input !== null &&
    typeof input === 'object' &&
    'request' in input &&
    typeof input.request === 'function'
  );
}

function acquireBrowserLock(
  manager: BrowserLockManager,
  request: LogoutCoordinationLockRequest,
): Promise<LogoutCoordinationLockResult> {
  if (
    !Number.isSafeInteger(request.timeoutMs) ||
    request.timeoutMs < 1 ||
    request.timeoutMs > 60_000
  ) {
    return Promise.resolve({ kind: 'failed', reason: 'adapter-failure' });
  }

  return new Promise((resolve) => {
    const abortController = new AbortController();
    let settled = false;
    let requestPromise: Promise<void> = Promise.resolve();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: LogoutCoordinationLockResult) => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      resolve(result);
    };
    if (!request.ifAvailable) {
      timeout = setTimeout(() => {
        abortController.abort();
        finish({ kind: 'failed', reason: 'timeout' });
      }, request.timeoutMs);
    }

    try {
      const options: LockOptions = request.ifAvailable
        ? { mode: request.mode, ifAvailable: true }
        : { mode: request.mode, signal: abortController.signal };
      requestPromise = manager
        .request(request.name, options, async (lock) => {
          if (lock === null) {
            finish({ kind: 'failed', reason: 'contended' });
            return;
          }
          let releaseLock: (() => void) | undefined;
          const released = new Promise<void>((release) => {
            releaseLock = release;
          });
          let leaseReleased = false;
          finish({
            kind: 'acquired',
            lease: {
              async release() {
                if (leaseReleased) return;
                leaseReleased = true;
                releaseLock?.();
                try {
                  await requestPromise;
                } catch {
                  // The lock has still been released by resolving the callback.
                }
              },
            },
          });
          await released;
        })
        .then(() => undefined);
      void requestPromise.catch(() => {
        finish({
          kind: 'failed',
          reason: abortController.signal.aborted
            ? 'timeout'
            : 'adapter-failure',
        });
      });
    } catch {
      finish({ kind: 'failed', reason: 'adapter-failure' });
    }
  });
}
