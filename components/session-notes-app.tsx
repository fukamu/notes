'use client';

import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { NotesApp, type NotesAppConfiguration } from '@/components/notes-app';
import {
  planNotesRuntimeLaunch,
  scopeMatchesVaultContext,
  vaultContextFromNotesScope,
  type NotesAccess,
} from '@/lib/application/notes-access';
import type { VaultNotesRuntimePorts } from '@/lib/application/notes-runtime';
import type {
  LogoutRuntimeFenceLease,
  LogoutRuntimeFencePort,
} from '@/lib/application/logout-runtime-coordination';
import type { VaultContext } from '@/lib/domain/identity';

export type VaultNotesRuntimeFactory = (
  context: VaultContext,
) => VaultNotesRuntimePorts;

export function SessionNotesApp({
  access,
  createRuntimePorts,
  unauthenticated,
  unavailable,
  runtimeFence,
  configuration,
}: {
  access: NotesAccess;
  createRuntimePorts: VaultNotesRuntimeFactory;
  unauthenticated: ReactNode;
  unavailable: ReactNode;
  runtimeFence: LogoutRuntimeFencePort;
  configuration?: NotesAppConfiguration;
}) {
  const plan = planNotesRuntimeLaunch(access);
  switch (plan.kind) {
    case 'do-not-start':
      return unauthenticated;
    case 'start': {
      const context = vaultContextFromNotesScope(plan.scope);
      return configuration ? (
        <AuthenticatedNotesApp
          key={`${plan.scope.sessionId}:${plan.scope.sessionEpoch}`}
          context={context}
          createRuntimePorts={createRuntimePorts}
          runtimeFence={runtimeFence}
          unavailable={unavailable}
          configuration={configuration}
        />
      ) : (
        <AuthenticatedNotesApp
          key={`${plan.scope.sessionId}:${plan.scope.sessionEpoch}`}
          context={context}
          createRuntimePorts={createRuntimePorts}
          runtimeFence={runtimeFence}
          unavailable={unavailable}
        />
      );
    }
  }
}

function AuthenticatedNotesApp({
  context,
  createRuntimePorts,
  runtimeFence,
  unavailable,
  configuration,
}: {
  context: VaultContext;
  createRuntimePorts: VaultNotesRuntimeFactory;
  runtimeFence: LogoutRuntimeFencePort;
  unavailable: ReactNode;
  configuration?: NotesAppConfiguration;
}) {
  const generation = useMemo<VaultContext>(
    () => ({
      accountId: context.accountId,
      vaultId: context.vaultId,
      sessionId: context.sessionId,
      sessionEpoch: context.sessionEpoch,
    }),
    [
      context.accountId,
      context.vaultId,
      context.sessionId,
      context.sessionEpoch,
    ],
  );
  const [fence, setFence] = useState<
    | { readonly kind: 'checking' }
    | { readonly kind: 'blocked' }
    | { readonly kind: 'entered'; readonly lease: LogoutRuntimeFenceLease }
    | { readonly kind: 'quiescing'; readonly lease: LogoutRuntimeFenceLease }
  >({ kind: 'checking' });

  useEffect(() => {
    let active = true;
    let enteredLease: LogoutRuntimeFenceLease | undefined;
    void runtimeFence
      .enter({
        generation,
        onPurgeRequested: () => {
          if (!active) return;
          setFence((current) =>
            current.kind === 'entered'
              ? { kind: 'quiescing', lease: current.lease }
              : { kind: 'blocked' },
          );
        },
      })
      .then((result) => {
        if (!active) {
          if (result.kind === 'entered') closeFence(result.lease);
          return;
        }
        if (result.kind === 'blocked') {
          setFence({ kind: 'blocked' });
          return;
        }
        enteredLease = result.lease;
        setFence({ kind: 'entered', lease: result.lease });
      })
      .catch(() => {
        if (active) setFence({ kind: 'blocked' });
      });

    return () => {
      active = false;
      if (enteredLease) closeFence(enteredLease);
    };
  }, [generation, runtimeFence]);

  if (fence.kind === 'checking' || fence.kind === 'blocked') return unavailable;
  const runtimeFenced = fence.kind === 'quiescing';
  return configuration ? (
    <FencedNotesRuntime
      context={context}
      createRuntimePorts={createRuntimePorts}
      lease={fence.lease}
      runtimeFenced={runtimeFenced}
      unavailable={unavailable}
      configuration={configuration}
    />
  ) : (
    <FencedNotesRuntime
      context={context}
      createRuntimePorts={createRuntimePorts}
      lease={fence.lease}
      runtimeFenced={runtimeFenced}
      unavailable={unavailable}
    />
  );
}

function FencedNotesRuntime({
  context,
  createRuntimePorts,
  lease,
  runtimeFenced,
  unavailable,
  configuration,
}: {
  context: VaultContext;
  createRuntimePorts: VaultNotesRuntimeFactory;
  lease: LogoutRuntimeFenceLease;
  runtimeFenced: boolean;
  unavailable: ReactNode;
  configuration?: NotesAppConfiguration;
}) {
  const [runtimePorts] = useState(() => createRuntimePorts(context));
  useEffect(() => () => closeFence(lease), [lease]);
  useEffect(() => {
    if (runtimeFenced) quiesceFence(lease);
  }, [lease, runtimeFenced]);
  if (!scopeMatchesVaultContext(runtimePorts.scope, context)) {
    throw new Error('Notes runtime scope does not match the session');
  }
  return configuration ? (
    <NotesApp
      configuration={configuration}
      runtimePorts={runtimePorts}
      runtimeFenced={runtimeFenced}
      runtimeFencedFallback={unavailable}
    />
  ) : (
    <NotesApp
      runtimePorts={runtimePorts}
      runtimeFenced={runtimeFenced}
      runtimeFencedFallback={unavailable}
    />
  );
}

function quiesceFence(lease: LogoutRuntimeFenceLease): void {
  void lease.quiesce().catch(() => undefined);
}

function closeFence(lease: LogoutRuntimeFenceLease): void {
  void lease.close().catch(() => undefined);
}
