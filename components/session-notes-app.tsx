'use client';

import { useState, type ReactNode } from 'react';
import { NotesApp, type NotesAppConfiguration } from '@/components/notes-app';
import {
  planNotesRuntimeLaunch,
  scopeMatchesVaultContext,
  vaultContextFromNotesScope,
  type NotesAccess,
  type VaultNotesScope,
} from '@/lib/application/notes-access';
import type { NotesRuntimePorts } from '@/lib/application/notes-runtime';
import type { VaultContext } from '@/lib/domain/identity';

export type VaultNotesRuntimeFactory = (
  context: VaultContext,
) => NotesRuntimePorts<VaultNotesScope>;

export function SessionNotesApp({
  access,
  createRuntimePorts,
  unauthenticated,
  configuration,
}: {
  access: NotesAccess;
  createRuntimePorts: VaultNotesRuntimeFactory;
  unauthenticated: ReactNode;
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
          configuration={configuration}
        />
      ) : (
        <AuthenticatedNotesApp
          key={`${plan.scope.sessionId}:${plan.scope.sessionEpoch}`}
          context={context}
          createRuntimePorts={createRuntimePorts}
        />
      );
    }
  }
}

function AuthenticatedNotesApp({
  context,
  createRuntimePorts,
  configuration,
}: {
  context: VaultContext;
  createRuntimePorts: VaultNotesRuntimeFactory;
  configuration?: NotesAppConfiguration;
}) {
  const [runtimePorts] = useState(() => createRuntimePorts(context));
  if (!scopeMatchesVaultContext(runtimePorts.scope, context)) {
    throw new Error('Notes runtime scope does not match the session');
  }
  return configuration ? (
    <NotesApp configuration={configuration} runtimePorts={runtimePorts} />
  ) : (
    <NotesApp runtimePorts={runtimePorts} />
  );
}
