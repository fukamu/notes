'use client';

import { useEffect, useState, type ReactNode } from 'react';
import {
  clearOfflineLaunchAdmission,
  hasOfflineLaunchAdmission,
  rememberOfflineLaunchAdmission,
} from '@/lib/client/production-launch-admission';
import { publicBuildEnvironmentValue } from '@/lib/environment/public-build';

type LaunchStatus = {
  readonly canAccess: boolean;
  readonly authenticated: boolean;
};

type LoadState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly status: LaunchStatus }
  | { readonly kind: 'unavailable' };

export function ProductionLaunchGate({ children }: { children: ReactNode }) {
  const [reloadKey, setReloadKey] = useState(0);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });

  useEffect(() => {
    const controller = new AbortController();
    void loadLaunchStatus(controller.signal).then((next) => {
      if (!controller.signal.aborted) setState(next);
    });
    return () => controller.abort();
  }, [reloadKey]);

  if (state.kind === 'ready' && state.status.canAccess) return children;

  return (
    <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-foreground">
      <div className="max-w-md space-y-4 text-center">
        <h1 className="text-xl font-semibold">FUKAMU Notes</h1>
        {state.kind === 'loading' ? (
          <p className="text-sm text-muted-foreground">確認しています。</p>
        ) : state.kind === 'unavailable' ? (
          <>
            <p className="text-sm text-muted-foreground">
              現在、アクセス状態を確認できません。しばらくしてから再度お試しください。
            </p>
            <button
              className="rounded-md border border-border px-3 py-2 text-sm"
              type="button"
              onClick={() => {
                setState({ kind: 'loading' });
                setReloadKey((value) => value + 1);
              }}
            >
              再試行
            </button>
          </>
        ) : (
          <>
            <p className="text-sm text-muted-foreground">
              現在、このサービスは限定公開中です。一般公開までしばらくお待ちください。
            </p>
            {!state.status.authenticated && configuredAuthEntryUrl ? (
              <a
                className="inline-block rounded-md border border-border px-3 py-2 text-sm"
                href={configuredAuthEntryUrl}
                target="_top"
              >
                許可済みアカウントでログイン
              </a>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}

const configuredAuthEntryUrl = resolveAuthEntryUrl(
  publicBuildEnvironmentValue('FUKAMU_AUTH_ENTRY_URL'),
);

export function resolveAuthEntryUrl(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (
    typeof value !== 'string' ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    value.includes('\\') ||
    Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    throw new Error(
      'FUKAMU_AUTH_ENTRY_URL must be a same-origin absolute path',
    );
  }
  const parsed = new URL(value, 'https://notes.invalid');
  if (
    parsed.origin !== 'https://notes.invalid' ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(
      'FUKAMU_AUTH_ENTRY_URL must be a same-origin absolute path',
    );
  }
  return `${parsed.pathname}${parsed.search}${parsed.hash}`;
}

async function loadLaunchStatus(signal: AbortSignal): Promise<LoadState> {
  try {
    const response = await fetch('/api/launch-status', {
      cache: 'no-store',
      credentials: 'same-origin',
      signal,
    });
    if (!response.ok) {
      clearOfflineLaunchAdmission();
      return { kind: 'unavailable' };
    }
    const value: unknown = await response.json();
    if (!isLaunchStatus(value)) {
      clearOfflineLaunchAdmission();
      return { kind: 'unavailable' };
    }
    if (value.canAccess) rememberOfflineLaunchAdmission();
    else clearOfflineLaunchAdmission();
    return { kind: 'ready', status: value };
  } catch {
    if (!navigator.onLine && hasOfflineLaunchAdmission()) {
      return {
        kind: 'ready',
        status: { canAccess: true, authenticated: true },
      };
    }
    return { kind: 'unavailable' };
  }
}

function isLaunchStatus(value: unknown): value is LaunchStatus {
  if (!value || typeof value !== 'object') return false;
  return (
    typeof Reflect.get(value, 'canAccess') === 'boolean' &&
    typeof Reflect.get(value, 'authenticated') === 'boolean'
  );
}
