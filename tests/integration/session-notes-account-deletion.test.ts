/** @vitest-environment happy-dom */

import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionNotesApp } from '@/components/session-notes-app';
import {
  accountDeletionContinuationTokenDecoder,
  type AccountDeletionHandoffRunner,
} from '@/lib/application/account-deletion-handoff';
import { vaultNotesScope } from '@/lib/application/notes-access';
import type { VaultNotesRuntimePorts } from '@/lib/application/notes-runtime';
import type { LogoutRuntimeFencePort } from '@/lib/application/logout-runtime-coordination';
import { decodeOrThrow } from '@/lib/codec/core';
import type { VaultContext } from '@/lib/domain/identity';
import { compatibilityIds } from '@/tests/fixtures/compatibility';
import { fixtureCardId, fixtureMutationId } from '@/tests/fixtures/ids';
import { sessionFixtureIds } from '@/tests/fixtures/session';

vi.mock('@/components/notes-app', () => ({
  NotesApp: (_props: { runtimeFencedFallback?: ReactNode }) =>
    createElement('p', null, 'Runtime mounted'),
}));

const context = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};
const continuationToken = decodeOrThrow(
  accountDeletionContinuationTokenDecoder,
  `ad1.${'S'.repeat(43)}.0`,
  'fixture continuation token',
);
const enteredFence: LogoutRuntimeFencePort = {
  enter: vi.fn<LogoutRuntimeFencePort['enter']>(async () => ({
    kind: 'entered',
    lease: {
      quiesce: async () => undefined,
      close: async () => undefined,
    },
  })),
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
  vi.clearAllMocks();
});

describe('SessionNotesApp account deletion boundary', () => {
  it('does not enter the runtime fence before durable deletion state is checked', async () => {
    const recovery =
      Promise.withResolvers<
        Awaited<ReturnType<AccountDeletionHandoffRunner['recover']>>
      >();
    const createRuntimePorts = vi.fn(createRuntime);
    await renderApp(
      runner({ recover: () => recovery.promise }),
      createRuntimePorts,
    );

    expect(document.body.textContent).toContain('退会処理の状態を確認');
    expect(createRuntimePorts).not.toHaveBeenCalled();
    expect(enteredFence.enter).not.toHaveBeenCalled();

    await act(async () => {
      recovery.resolve({ kind: 'idle' });
      await recovery.promise;
      await flush();
    });
    expect(document.body.textContent).toContain('Runtime mounted');
    expect(createRuntimePorts).toHaveBeenCalledExactlyOnceWith(context);
  });

  it('requires explicit confirmation and passes only the trusted generation to begin', async () => {
    const begin = vi.fn<AccountDeletionHandoffRunner['begin']>(async () => ({
      kind: 'pending' as const,
      localContent: 'deleted' as const,
      status: { kind: 'in-progress' as const, continuationToken },
    }));
    await renderApp(runner({ begin }), vi.fn(createRuntime));
    await act(flush);

    clickButton('アカウントを削除');
    await act(flush);
    expect(
      document.querySelector('[role="alertdialog"]')?.textContent,
    ).toContain('元に戻すことはできません');
    expect(begin).not.toHaveBeenCalled();

    clickButton('削除を開始');
    await act(flush);
    expect(begin).toHaveBeenCalledExactlyOnceWith(context);
    expect(document.body.textContent).not.toContain('Runtime mounted');
    expect(document.body.textContent).toContain(
      '端末内のデータは削除されました',
    );
  });

  it('blocks anonymous content while a post-revocation marker is pending', async () => {
    const resumeServer = vi.fn<AccountDeletionHandoffRunner['resumeServer']>(
      async () => ({ kind: 'terminal', status: 'completed' }),
    );
    const accountDeletion = runner({
      recover: async () => ({
        kind: 'pending',
        localContent: 'deleted',
        status: { kind: 'in-progress', continuationToken },
      }),
      resumeServer,
    });
    const container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root?.render(
        createElement(SessionNotesApp, {
          access: { kind: 'anonymous' },
          createRuntimePorts: vi.fn(createRuntime),
          runtimeFence: enteredFence,
          unauthenticated: createElement('p', null, 'Sign in required'),
          unavailable: createElement('p', null, 'Unavailable'),
          accountDeletion,
        }),
      );
      await flush();
    });

    expect(document.body.textContent).not.toContain('Sign in required');
    expect(document.body.textContent).toContain('サーバー側の退会処理は継続中');
    clickButton('状態を確認');
    await act(flush);
    expect(resumeServer).toHaveBeenCalledOnce();
  });
});

async function renderApp(
  accountDeletion: AccountDeletionHandoffRunner,
  createRuntimePorts: (context: VaultContext) => VaultNotesRuntimePorts,
): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(SessionNotesApp, {
        access: { kind: 'authenticated', context },
        createRuntimePorts,
        runtimeFence: enteredFence,
        unauthenticated: createElement('p', null, 'Sign in required'),
        unavailable: createElement('p', null, 'Unavailable'),
        accountDeletion,
      }),
    );
    await flush();
  });
}

function runner(
  overrides: Partial<AccountDeletionHandoffRunner> = {},
): AccountDeletionHandoffRunner {
  return {
    begin: vi.fn<AccountDeletionHandoffRunner['begin']>(async () => ({
      kind: 'terminal',
      status: 'completed',
    })),
    recover: vi.fn<AccountDeletionHandoffRunner['recover']>(async () => ({
      kind: 'idle',
    })),
    resumeServer: vi.fn<AccountDeletionHandoffRunner['resumeServer']>(
      async () => ({ kind: 'terminal', status: 'completed' }),
    ),
    ...overrides,
  };
}

function clickButton(label: string): void {
  const match = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === label,
  );
  if (!match) throw new Error(`button not found: ${label}`);
  act(() => match.click());
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
      createCardId: () => fixtureCardId('account-deletion'),
      createMutationId: () => fixtureMutationId('account-deletion'),
      createDeviceId: () => compatibilityIds.device,
    },
    connectivity: {
      isOnline: () => false,
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
