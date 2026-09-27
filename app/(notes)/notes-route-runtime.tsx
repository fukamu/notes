'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { AccountDeletionBoundary } from '@/components/account-deletion-boundary';
import { AuthenticatedNotesBootstrap } from '@/components/authenticated-notes-bootstrap';
import type { AccountDeletionHandoffRunner } from '@/lib/application/account-deletion-handoff';
import { createBrowserAccountDeletionRunner } from '@/lib/client/browser-account-deletion';
import {
  createBrowserLogoutPurgeService,
  type BrowserLogoutPurgeService,
} from '@/lib/client/browser-logout-purge';
import type { VaultContext } from '@/lib/domain/identity';
import { ProductionLaunchGate } from './production-launch-gate';

/**
 * The deletion recovery boundary intentionally owns the launch and session
 * gates. A durable deletion marker must remain recoverable after revocation or
 * launch denial, while ordinary Notes content still requires both gates.
 */
export function NotesRouteRuntime({
  children,
}: {
  readonly children: ReactNode;
}) {
  const [composition, setComposition] = useState<NotesRouteComposition>();
  const [generation, setGeneration] = useState<VaultContext>();
  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      const logout = createBrowserLogoutPurgeService();
      setComposition({
        logout,
        accountDeletion: createBrowserAccountDeletionRunner(logout),
      });
    });
    return () => {
      active = false;
    };
  }, []);
  const updateGeneration = useCallback(
    (next: VaultContext | undefined) => setGeneration(next),
    [],
  );
  if (!composition) {
    return (
      <main className="grid min-h-[100dvh] place-items-center bg-background p-6 text-foreground">
        <p>退会処理の状態を確認しています。</p>
      </main>
    );
  }
  const gatedRuntime = (
    <ProductionLaunchGate>
      <AuthenticatedNotesBootstrap
        logout={composition.logout}
        onGeneration={updateGeneration}
      />
      {children}
    </ProductionLaunchGate>
  );
  return generation ? (
    <AccountDeletionBoundary
      runner={composition.accountDeletion}
      generation={generation}
    >
      {gatedRuntime}
    </AccountDeletionBoundary>
  ) : (
    <AccountDeletionBoundary runner={composition.accountDeletion}>
      {gatedRuntime}
    </AccountDeletionBoundary>
  );
}

type NotesRouteComposition = {
  readonly logout: BrowserLogoutPurgeService;
  readonly accountDeletion: AccountDeletionHandoffRunner;
};
