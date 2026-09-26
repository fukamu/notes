/** @vitest-environment happy-dom */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NotesRouteRuntime } from '@/app/(notes)/notes-route-runtime';
import { accountDeletionContinuationTokenDecoder } from '@/lib/application/account-deletion-handoff';
import { decodeOrThrow } from '@/lib/codec/core';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const harness = vi.hoisted(() => ({
  loadSessionContext: vi.fn(),
  createAccountDeletion: vi.fn(),
  sessionNotesApp: vi.fn(),
  runner: {
    begin: vi.fn(),
    recover: vi.fn(),
    resumeServer: vi.fn(),
  },
  logout: {
    runtimeFence: { enter: vi.fn() },
    purge: { prepare: vi.fn(), run: vi.fn() },
  },
}));

vi.mock('@/lib/client/http-session-context', () => ({
  loadSessionContext: harness.loadSessionContext,
}));

vi.mock('@/lib/client/browser-logout-purge', () => ({
  createBrowserLogoutPurgeService: () => harness.logout,
}));

vi.mock('@/lib/client/browser-account-deletion', () => ({
  createBrowserAccountDeletionRunner: (...input: readonly unknown[]) => {
    harness.createAccountDeletion(...input);
    return harness.runner;
  },
}));

vi.mock('@/lib/client/vault-notes-runtime', () => ({
  createVaultNotesRuntimePorts: vi.fn(),
}));

vi.mock('@/components/session-notes-app', () => ({
  SessionNotesApp: (...input: readonly unknown[]) => {
    harness.sessionNotesApp(...input);
    return createElement('p', null, 'Authenticated runtime');
  },
}));

const continuationToken = decodeOrThrow(
  accountDeletionContinuationTokenDecoder,
  `ad1.${'S'.repeat(43)}.1`,
  'fixture continuation token',
);

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
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('Notes route account deletion recovery composition', () => {
  it('recovers a durable capability without requesting launch, session, or Notes runtime', async () => {
    const launch = vi.fn(async () => ({ ok: false, status: 503 }));
    vi.stubGlobal('fetch', launch);
    harness.runner.recover.mockResolvedValue({
      kind: 'pending',
      localContent: 'deleted',
      status: { kind: 'in-progress', continuationToken },
    });

    await renderRoute();

    expect(harness.createAccountDeletion).toHaveBeenCalledExactlyOnceWith(
      harness.logout,
    );
    expect(harness.runner.recover).toHaveBeenCalledOnce();
    expect(document.body.textContent).toContain('サーバー側の退会処理は継続中');
    expect(document.body.textContent).not.toContain('ログインが必要です');
    expect(document.body.textContent).not.toContain('Route child');
    expect(launch).not.toHaveBeenCalled();
    expect(harness.loadSessionContext).not.toHaveBeenCalled();
    expect(harness.sessionNotesApp).not.toHaveBeenCalled();
  });

  it('mounts launch, session, and the shared logout fence only after recovery is idle', async () => {
    const recovery = Promise.withResolvers<{ readonly kind: 'idle' }>();
    const launch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ canAccess: true, authenticated: true }),
    }));
    vi.stubGlobal('fetch', launch);
    harness.loadSessionContext.mockResolvedValue({
      kind: 'authenticated',
      context: {
        accountId: sessionFixtureIds.accountId,
        vaultId: sessionFixtureIds.vaultId,
        sessionId: sessionFixtureIds.sessionId,
        sessionEpoch: sessionFixtureIds.epoch,
      },
      accountDeletionAvailable: false,
    });
    harness.runner.recover.mockReturnValue(recovery.promise);

    await renderRoute(false);
    expect(document.body.textContent).toContain('退会処理の状態を確認');
    expect(launch).not.toHaveBeenCalled();
    expect(harness.loadSessionContext).not.toHaveBeenCalled();
    expect(harness.sessionNotesApp).not.toHaveBeenCalled();

    await act(async () => {
      recovery.resolve({ kind: 'idle' });
      await recovery.promise;
      await flush();
      await flush();
      await flush();
    });
    expect(document.body.textContent).toContain('Authenticated runtime');
    expect(document.body.textContent).toContain('Route child');
    expect(launch).toHaveBeenCalledOnce();
    expect(harness.loadSessionContext).toHaveBeenCalledOnce();
    expect(harness.sessionNotesApp).toHaveBeenCalledOnce();
    expect(harness.sessionNotesApp.mock.calls[0]?.[0]).toMatchObject({
      runtimeFence: harness.logout.runtimeFence,
    });
    expect(document.body.textContent).not.toContain('アカウントを削除');
  });

  it('starts deletion from the outer boundary with the authenticated Vault generation', async () => {
    const context = {
      accountId: sessionFixtureIds.accountId,
      vaultId: sessionFixtureIds.vaultId,
      sessionId: sessionFixtureIds.sessionId,
      sessionEpoch: sessionFixtureIds.epoch,
    } as const;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ canAccess: true, authenticated: true }),
      })),
    );
    harness.loadSessionContext.mockResolvedValue({
      kind: 'authenticated',
      context,
      accountDeletionAvailable: true,
    });
    harness.runner.recover.mockResolvedValue({ kind: 'idle' });
    harness.runner.begin.mockResolvedValue({
      kind: 'terminal',
      status: 'completed',
    });

    await renderRoute();
    await act(async () => {
      findButton('アカウントを削除').click();
      await flush();
    });
    await act(async () => {
      findButton('削除を開始').click();
      await flush();
    });

    expect(harness.runner.begin).toHaveBeenCalledExactlyOnceWith(context);
  });
});

async function renderRoute(flushAll = true): Promise<void> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(
      createElement(
        NotesRouteRuntime,
        null,
        createElement('p', null, 'Route child'),
      ),
    );
    await flush();
    if (flushAll) await flush();
  });
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

function findButton(label: string): HTMLButtonElement {
  const candidate = Array.from(document.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label,
  );
  if (!candidate) throw new Error(`missing button: ${label}`);
  return candidate;
}
