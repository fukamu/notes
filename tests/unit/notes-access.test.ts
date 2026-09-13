import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SessionNotesApp } from '@/components/session-notes-app';
import {
  planNotesRuntimeLaunch,
  scopeMatchesVaultContext,
  type VaultNotesScope,
} from '@/lib/application/notes-access';
import type { NotesRuntimePorts } from '@/lib/application/notes-runtime';
import type { LogoutRuntimeFencePort } from '@/lib/application/logout-runtime-coordination';
import type { VaultContext } from '@/lib/domain/identity';
import { sessionFixtureIds } from '@/tests/fixtures/session';

const context: VaultContext = {
  accountId: sessionFixtureIds.accountId,
  vaultId: sessionFixtureIds.vaultId,
  sessionId: sessionFixtureIds.sessionId,
  sessionEpoch: sessionFixtureIds.epoch,
};

const blockedFence: LogoutRuntimeFencePort = {
  enter: async () => ({ kind: 'blocked', reason: 'purge-pending' }),
};

describe('authenticated notes composition', () => {
  it('does not create or mount a notes runtime for anonymous access', () => {
    const createRuntimePorts = vi.fn(
      (_context: VaultContext): NotesRuntimePorts<VaultNotesScope> => {
        throw new Error('anonymous runtime must not be created');
      },
    );
    const html = renderToStaticMarkup(
      createElement(SessionNotesApp, {
        access: { kind: 'anonymous' },
        createRuntimePorts,
        unauthenticated: createElement('p', null, 'Sign in required'),
        unavailable: createElement('p', null, 'Unavailable'),
        runtimeFence: blockedFence,
      }),
    );

    expect(html).toBe('<p>Sign in required</p>');
    expect(createRuntimePorts).not.toHaveBeenCalled();
  });

  it('derives a vault scope only for authenticated access', () => {
    expect(planNotesRuntimeLaunch({ kind: 'anonymous' })).toEqual({
      kind: 'do-not-start',
      reason: 'anonymous',
    });
    const plan = planNotesRuntimeLaunch({ kind: 'authenticated', context });
    expect(plan).toEqual({
      kind: 'start',
      scope: { kind: 'vault', ...context },
    });
    if (plan.kind !== 'start') return;
    expect(scopeMatchesVaultContext(plan.scope, context)).toBe(true);
    expect(
      scopeMatchesVaultContext(
        { ...plan.scope, sessionEpoch: sessionFixtureIds.nextEpoch },
        context,
      ),
    ).toBe(false);
  });

  it('does not construct an authenticated runtime before the async fence enters', () => {
    const createRuntimePorts = vi.fn(
      (_context: VaultContext): NotesRuntimePorts<VaultNotesScope> => {
        throw new Error('authenticated runtime constructed');
      },
    );

    const html = renderToStaticMarkup(
      createElement(SessionNotesApp, {
        access: { kind: 'authenticated', context },
        createRuntimePorts,
        unauthenticated: null,
        unavailable: createElement('p', null, 'Checking logout state'),
        runtimeFence: blockedFence,
      }),
    );
    expect(html).toBe('<p>Checking logout state</p>');
    expect(createRuntimePorts).not.toHaveBeenCalled();
  });
});
