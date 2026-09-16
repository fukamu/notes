'use client';

import type { NotesScope } from '@/lib/application/notes-runtime';
import type { FullNetworkLayoutExecutionPort } from '@/lib/application/full-network-layout-controller';
import { fullNetworkLayoutWorkerUrl } from '@/lib/client/full-network-layout-worker-url';
import type { FullNetworkLayoutWorkerRequest } from '@/lib/graph/full-network-layout-protocol';

const cancelledMessage = 'Full-network layout worker operation was cancelled';
const destroyedMessage = 'Full-network layout worker scope was destroyed';

export type FullNetworkLayoutWorkerPort = Readonly<{
  postMessage: (message: FullNetworkLayoutWorkerRequest) => void;
  addEventListener: (
    type: 'message' | 'error',
    listener: EventListener,
  ) => void;
  removeEventListener: (
    type: 'message' | 'error',
    listener: EventListener,
  ) => void;
  terminate: () => void;
}>;

export type FullNetworkLayoutWorkerExecution = FullNetworkLayoutExecutionPort &
  Readonly<{
    isDestroyed: () => boolean;
    hasInFlightRequest: () => boolean;
  }>;

type Pending = Readonly<{
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
}>;

export function createFullNetworkLayoutWorkerExecution(input: {
  readonly scope: NotesScope;
  readonly createWorker: () => FullNetworkLayoutWorkerPort;
  readonly onDestroy?: () => void;
}): FullNetworkLayoutWorkerExecution {
  let worker: FullNetworkLayoutWorkerPort | null = null;
  let pending: Pending | null = null;
  let destroyed = false;

  const disposeWorker = (): void => {
    const active = worker;
    if (!active) return;
    active.removeEventListener('message', handleMessage);
    active.removeEventListener('error', handleError);
    active.terminate();
    worker = null;
  };
  const rejectPending = (message: string): void => {
    const active = pending;
    pending = null;
    if (active) active.reject(new Error(message));
  };
  function handleMessage(event: Event): void {
    if (!(event instanceof MessageEvent)) {
      rejectPending('Full-network layout worker returned an invalid event');
      disposeWorker();
      return;
    }
    const active = pending;
    pending = null;
    if (active) active.resolve(event.data);
  }
  function handleError(): void {
    rejectPending('Full-network layout worker failed');
    disposeWorker();
  }
  const currentWorker = (): FullNetworkLayoutWorkerPort => {
    if (destroyed) throw new Error(destroyedMessage);
    if (worker) return worker;
    const created = input.createWorker();
    created.addEventListener('message', handleMessage);
    created.addEventListener('error', handleError);
    worker = created;
    return created;
  };
  const cancel = (): void => {
    rejectPending(cancelledMessage);
    disposeWorker();
  };

  return {
    scope: input.scope,
    run: (request) => {
      if (destroyed) return Promise.reject(new Error(destroyedMessage));
      if (pending) cancel();
      return new Promise<unknown>((resolve, reject) => {
        const active = currentWorker();
        pending = { resolve, reject };
        try {
          active.postMessage(request);
        } catch {
          rejectPending('Full-network layout worker postMessage failed');
          disposeWorker();
        }
      });
    },
    cancel,
    destroy: () => {
      if (destroyed) return;
      destroyed = true;
      rejectPending(destroyedMessage);
      disposeWorker();
      input.onDestroy?.();
    },
    isDestroyed: () => destroyed && worker === null && pending === null,
    hasInFlightRequest: () => pending !== null,
  };
}

export function createBrowserFullNetworkLayoutExecution(
  scope: NotesScope,
): FullNetworkLayoutWorkerExecution {
  let unregister = (): void => undefined;
  const execution = createFullNetworkLayoutWorkerExecution({
    scope,
    createWorker: () =>
      new Worker(fullNetworkLayoutWorkerUrl, {
        type: 'module',
        name: 'fukamu-full-network-layout',
      }),
    onDestroy: () => unregister(),
  });
  const reset = (): void => execution.destroy();
  activeBrowserExecutions.add(reset);
  unregister = (): void => {
    activeBrowserExecutions.delete(reset);
  };
  return execution;
}

const activeBrowserExecutions = new Set<() => void>();

export function resetFullNetworkLayoutWorkers(): void {
  for (const reset of activeBrowserExecutions) reset();
}

export function fullNetworkLayoutWorkersAreReset(): boolean {
  return activeBrowserExecutions.size === 0;
}
