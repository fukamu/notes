'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { SessionNotesApp } from '@/components/session-notes-app';
import type { NotesAccess } from '@/lib/application/notes-access';
import type { BrowserLogoutPurgeService } from '@/lib/client/browser-logout-purge';
import { loadSessionContext } from '@/lib/client/http-session-context';
import { createVaultNotesRuntimePorts } from '@/lib/client/vault-notes-runtime';
import type { VaultContext } from '@/lib/domain/identity';

type BootstrapState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'loaded'; readonly access: NotesAccess }
  | { readonly kind: 'unavailable' };

export function AuthenticatedNotesBootstrap({
  logout,
  onGeneration,
}: {
  readonly logout: BrowserLogoutPurgeService;
  readonly onGeneration: (generation: VaultContext | undefined) => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<BootstrapState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void loadSessionContext(undefined, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      switch (result.kind) {
        case 'authenticated':
          setState({ kind: 'loaded', access: result });
          onGeneration(
            result.accountDeletionAvailable ? result.context : undefined,
          );
          break;
        case 'anonymous':
          setState({ kind: 'loaded', access: result });
          onGeneration(undefined);
          break;
        case 'unavailable':
          setState(result);
          onGeneration(undefined);
          break;
      }
    });
    return () => {
      controller.abort();
      onGeneration(undefined);
    };
  }, [attempt, onGeneration]);

  let content: ReactNode;
  if (state.kind === 'loading') {
    content = (
      <NotesRuntimeMessage>セッションを確認しています。</NotesRuntimeMessage>
    );
  } else if (state.kind === 'unavailable') {
    content = (
      <NotesRuntimeMessage>
        <p>セッションを確認できませんでした。</p>
        <button
          className="rounded-md border border-border px-3 py-2 text-sm"
          type="button"
          onClick={() => {
            setState({ kind: 'loading' });
            setAttempt((value) => value + 1);
          }}
        >
          再試行
        </button>
      </NotesRuntimeMessage>
    );
  } else if (state.access.kind === 'anonymous') {
    content = <NotesRuntimeMessage>ログインが必要です。</NotesRuntimeMessage>;
  } else {
    content = (
      <AuthenticatedNotesRuntime
        context={state.access.context}
        logout={logout}
      />
    );
  }
  return content;
}

function AuthenticatedNotesRuntime({
  context,
  logout,
}: {
  readonly context: VaultContext;
  readonly logout: BrowserLogoutPurgeService;
}) {
  return (
    <SessionNotesApp
      access={{ kind: 'authenticated', context }}
      createRuntimePorts={createVaultNotesRuntimePorts}
      unauthenticated={
        <NotesRuntimeMessage>ログインが必要です。</NotesRuntimeMessage>
      }
      unavailable={
        <NotesRuntimeMessage>
          ローカルデータを安全に準備できません。
        </NotesRuntimeMessage>
      }
      runtimeFence={logout.runtimeFence}
    />
  );
}

function NotesRuntimeMessage({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
      <div className="space-y-4 text-center text-sm text-muted-foreground">
        {children}
      </div>
    </main>
  );
}
