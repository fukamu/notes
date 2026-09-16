'use client';

import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useEffect, useReducer, type ReactNode } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  accountDeletionUiReducer,
  type AccountDeletionHandoffRunner,
  type AccountDeletionRunResult,
  type AccountDeletionUiState,
} from '@/lib/application/account-deletion-handoff';
import type { LogoutPurgeGeneration } from '@/lib/application/logout-purge';

export function AccountDeletionBoundary({
  runner,
  generation,
  children,
}: {
  readonly runner: AccountDeletionHandoffRunner;
  readonly generation?: LogoutPurgeGeneration;
  readonly children: ReactNode;
}) {
  const [state, dispatch] = useReducer(accountDeletionUiReducer, {
    kind: 'checking',
  } satisfies AccountDeletionUiState);

  useEffect(() => {
    let active = true;
    void runner
      .recover()
      .then((result) => {
        if (active) dispatch({ type: 'run-finished', result });
      })
      .catch(() => {
        if (active) {
          dispatch({
            type: 'run-finished',
            result: { kind: 'failed', reason: 'progress-unavailable' },
          });
        }
      });
    return () => {
      active = false;
    };
  }, [runner]);

  const execute = (effect: () => Promise<AccountDeletionRunResult>) => {
    dispatch({ type: 'work-requested' });
    void effect()
      .then((result) => dispatch({ type: 'run-finished', result }))
      .catch(() =>
        dispatch({
          type: 'run-finished',
          result: { kind: 'failed', reason: 'progress-unavailable' },
        }),
      );
  };

  switch (state.kind) {
    case 'checking':
      return <StatusPanel>退会処理の状態を確認しています。</StatusPanel>;
    case 'working':
      return <StatusPanel>退会処理を進めています。</StatusPanel>;
    case 'pending':
      return (
        <StatusPanel>
          {state.localContent === 'deleted' ? (
            <p>
              端末内のデータは削除されました。サーバー側の退会処理は継続中です。
            </p>
          ) : (
            <p>
              退会開始を受け付けました。セッション無効化を待っているためノートを表示していません。端末内データの削除はまだ完了していません。
            </p>
          )}
          {state.status.kind === 'retry-wait' ? (
            <p className="text-sm text-muted-foreground">
              一時的に処理を待機しています。しばらくしてから状態を確認してください。
            </p>
          ) : null}
          <Button onClick={() => execute(() => runner.resumeServer())}>
            状態を確認
          </Button>
        </StatusPanel>
      );
    case 'error':
      return (
        <StatusPanel>
          <p role="alert">退会処理を続行できませんでした。</p>
          <p className="text-sm text-muted-foreground">
            ノートは表示せず、保存済みの処理状態から安全に再開します。
          </p>
          <Button onClick={() => execute(() => runner.resumeServer())}>
            再試行
          </Button>
        </StatusPanel>
      );
    case 'terminal':
      return state.status === 'completed' ? (
        <StatusPanel>
          退会手続きが完了し、この端末内のノートを削除しました。
        </StatusPanel>
      ) : (
        <StatusPanel>
          <p role="alert">
            退会処理を完了できませんでした。この端末内のノートは削除済みです。サポートへお問い合わせください。
          </p>
        </StatusPanel>
      );
    case 'idle':
    case 'confirming':
      return (
        <>
          {children}
          {generation ? (
            <AlertDialog.Root
              open={state.kind === 'confirming'}
              onOpenChange={(open) =>
                dispatch({
                  type: open
                    ? 'confirmation-requested'
                    : 'confirmation-cancelled',
                })
              }
            >
              <AlertDialog.Trigger
                className={buttonVariants({
                  variant: 'destructive',
                  size: 'sm',
                  className: 'fixed right-4 bottom-4 z-40 shadow-sm',
                })}
              >
                アカウントを削除
              </AlertDialog.Trigger>
              <AlertDialog.Portal>
                <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/45" />
                <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
                  <AlertDialog.Popup className="w-full max-w-md rounded-xl border border-border bg-background p-5 text-foreground shadow-xl outline-none">
                    <AlertDialog.Title className="text-lg font-semibold">
                      アカウントを削除しますか？
                    </AlertDialog.Title>
                    <AlertDialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">
                      退会処理を開始するとセッションを無効化し、この端末のノートを削除します。元に戻すことはできません。
                    </AlertDialog.Description>
                    <div className="mt-5 flex justify-end gap-2">
                      <AlertDialog.Close
                        className={buttonVariants({ variant: 'outline' })}
                      >
                        キャンセル
                      </AlertDialog.Close>
                      <AlertDialog.Close
                        className={buttonVariants({ variant: 'destructive' })}
                        onClick={() => execute(() => runner.begin(generation))}
                      >
                        削除を開始
                      </AlertDialog.Close>
                    </div>
                  </AlertDialog.Popup>
                </AlertDialog.Viewport>
              </AlertDialog.Portal>
            </AlertDialog.Root>
          ) : null}
        </>
      );
  }
}

function StatusPanel({ children }: { readonly children: ReactNode }) {
  return (
    <main className="grid min-h-[100dvh] place-items-center bg-background p-6 text-foreground">
      <div className="flex max-w-lg flex-col items-start gap-4 rounded-xl border border-border bg-card p-6 shadow-sm">
        {children}
      </div>
    </main>
  );
}
