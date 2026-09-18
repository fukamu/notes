/** @vitest-environment happy-dom */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionNotesApp } from '@/components/session-notes-app';
import { vaultNotesScope } from '@/lib/application/notes-access';
import type { VaultNotesRuntimePorts } from '@/lib/application/notes-runtime';
import type {
  LogoutRuntimeFenceEnterResult,
  LogoutRuntimeFencePort,
} from '@/lib/application/logout-runtime-coordination';
import { compatibilityIds } from '@/tests/fixtures/compatibility';
import { fixtureCardId, fixtureMutationId } from '@/tests/fixtures/ids';
import { sessionFixtureIds } from '@/tests/fixtures/session';

vi.mock('@/components/notes-app', () => ({
  NotesApp: (props: {
    runtimeFenced?: boolean;
    runtimeFencedFallback?: ReactNode;
  }) =>
    props.runtimeFenced
      ? props.runtimeFencedFallback
      : createElement('p', null, 'Runtime mounted'),
}));

const context = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

let root: Root | undefined;

beforeAll(() => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  if (root) {
    act(() => root?.unmount());
    root = undefined;
  }
  document.body.replaceChildren();
});

describe('SessionNotesApp logout runtime fence', () => {
  it('constructs only after entry and releases before a purge remains blocked', async () => {
    const entry = Promise.withResolvers<LogoutRuntimeFenceEnterResult>();
    const quiesce = vi.fn(async () => undefined);
    const close = vi.fn(async () => undefined);
    let requestPurge: (() => void) | undefined;
    const runtimeFence: LogoutRuntimeFencePort = {
      enter: vi.fn(
        async (input: Parameters<LogoutRuntimeFencePort['enter']>[0]) => {
          requestPurge = input.onPurgeRequested;
          return entry.promise;
        },
      ),
    };
    const createRuntimePorts = vi.fn(createRuntime);

    await renderSessionNotesApp(runtimeFence, createRuntimePorts);
    expect(document.body.textContent).toContain('Checking logout state');
    expect(createRuntimePorts).not.toHaveBeenCalled();

    await act(async () => {
      entry.resolve({ kind: 'entered', lease: { quiesce, close } });
      await entry.promise;
      await flush();
    });
    expect(createRuntimePorts).toHaveBeenCalledExactlyOnceWith(context);
    expect(document.body.textContent).not.toContain('Checking logout state');

    await act(async () => {
      requestPurge?.();
      await flush();
    });
    expect(document.body.textContent).toContain('Checking logout state');
    expect(quiesce).toHaveBeenCalledOnce();
    expect(close).not.toHaveBeenCalled();
  });

  it('fails closed when the fence rejects and never constructs the runtime', async () => {
    const runtimeFence: LogoutRuntimeFencePort = {
      enter: vi.fn(async () => {
        throw new Error('progress unavailable');
      }),
    };
    const createRuntimePorts = vi.fn(createRuntime);
    await renderSessionNotesApp(runtimeFence, createRuntimePorts);
    await act(flush);
    expect(document.body.textContent).toContain('Checking logout state');
    expect(createRuntimePorts).not.toHaveBeenCalled();
  });
});

async function renderSessionNotesApp(
  runtimeFence: LogoutRuntimeFencePort,
  createRuntimePorts: () => VaultNotesRuntimePorts,
): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(SessionNotesApp, {
        access: { kind: 'authenticated', context },
        createRuntimePorts,
        runtimeFence,
        unauthenticated: createElement('p', null, 'Sign in required'),
        unavailable: createElement('p', null, 'Checking logout state'),
      }),
    );
    await flush();
  });
}

function createRuntime(): VaultNotesRuntimePorts {
  const scope = vaultNotesScope(context);
  return {
    scope,
    repository: {
      scope,
      loadCards: async () => [],
      loadConflicts: async () => [],
      loadOrCreateDeviceId: async () => compatibilityIds.device,
      loadPendingMutations: async () => [],
      persistLocalCard: async () => {},
      persistCardAndMutation: async (card) => {
        throw new Error(`unexpected save for ${card.id}`);
      },
      applySyncResponse: async () => ({ cards: [], conflicts: [] }),
    },
    sync: {
      kind: 'v2',
      client: {
        scope,
        synchronize: async () => ({
          kind: 'completed',
          cards: [],
          conflicts: [],
        }),
      },
    },
    clock: { now: () => 1_000 },
    idGenerator: {
      createCardId: () => fixtureCardId('logout-fence'),
      createMutationId: () => fixtureMutationId('logout-fence'),
      createDeviceId: () => compatibilityIds.device,
    },
    connectivity: {
      isOnline: () => false,
      subscribe: () => () => undefined,
    },
    foregroundResume: {
      subscribe: () => () => undefined,
    },
    offlineApp: {
      prepare: async () => undefined,
      purge: async () => undefined,
    },
  };
}

async function flush(): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, 0));
  await Promise.resolve();
}
