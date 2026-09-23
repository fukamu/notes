'use client';

import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useMemo, useReducer, useRef } from 'react';
import { PublicRouteLink } from '@/components/public-route-link';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  billingCancellationUiReducer,
  initialBillingCancellationUiState,
  type BillingCancellationFailure,
} from '@/lib/application/billing-ui';
import {
  createBillingCancellationIdempotencyKey,
  createBillingUiHttpTransport,
} from '@/lib/client/http-billing-ui';
import type { SubscriptionCancellationIdempotencyKey } from '@/server/billing/public';

export function BillingAccountBoundary({
  source,
  cancellationPolicy,
}: {
  readonly source: 'local-fixture' | 'server';
  readonly cancellationPolicy: string;
}) {
  const transport = useMemo(() => createBillingUiHttpTransport(), []);
  const [state, dispatch] = useReducer(
    billingCancellationUiReducer,
    initialBillingCancellationUiState,
  );
  const idempotencyKey = useRef<
    SubscriptionCancellationIdempotencyKey | undefined
  >(undefined);
  const pending = useRef(false);

  const submit = async () => {
    if (pending.current) return;
    pending.current = true;
    dispatch({ type: 'submit-requested' });
    const key =
      idempotencyKey.current ?? createBillingCancellationIdempotencyKey();
    idempotencyKey.current = key;
    const result = await transport.cancelSubscription(key);
    pending.current = false;
    switch (result.kind) {
      case 'confirmed':
        dispatch({
          type: 'confirmed',
          confirmation: {
            source: 'server',
            outcome: result.outcome,
            confirmedAt: result.confirmedAt,
            accessEndsAt: result.accessEndsAt,
          },
        });
        return;
      case 'not-found':
        dispatch(
          source === 'local-fixture'
            ? {
                type: 'confirmed',
                confirmation: { source: 'local-fixture' },
              }
            : { type: 'submit-failed', failure: 'unavailable' },
        );
        return;
      case 'authentication-required':
        dispatch({
          type: 'submit-failed',
          failure: 'authentication-required',
        });
        return;
      case 'cancellation-unavailable':
        dispatch({
          type: 'submit-failed',
          failure: 'cancellation-unavailable',
        });
        return;
      case 'unavailable':
        dispatch({ type: 'submit-failed', failure: 'unavailable' });
        return;
    }
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <p className="text-xs font-bold tracking-[0.18em] text-muted-foreground">
        ACCOUNT / BILLING
      </p>
      <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        契約管理
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
        サブスクリプションの解約を、この専用ページから手続きできます。ノートの編集画面には契約条件や解約ダイアログを常設しません。
      </p>

      {source === 'local-fixture' ? (
        <aside
          className="mt-7 rounded-2xl border border-amber-700/25 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
          aria-label="開発用表示"
          data-testid="billing-fixture-notice"
        >
          ローカル開発・テスト専用のサンプルです。解約操作を試しても実際の契約や課金状態は変更されません。
        </aside>
      ) : null}

      <section
        className="mt-8 rounded-3xl border bg-card px-6 py-7 shadow-sm sm:px-8"
        aria-labelledby="subscription-heading"
      >
        <h2
          id="subscription-heading"
          className="font-heading text-2xl font-semibold"
        >
          サブスクリプション
        </h2>
        <p className="mt-4 text-sm leading-7">{cancellationPolicy}</p>
        <ul className="mt-5 list-disc space-y-2 pl-5 text-sm leading-7 text-foreground/85">
          <li>アプリの削除やログアウトだけでは解約されません。</li>
          <li>サブスクリプションの解約とアカウント退会は別手続きです。</li>
          <li>支払い停止中でも、この解約経路は利用できます。</li>
          <li>providerから確認できるまで、解約済みとは表示しません。</li>
        </ul>

        {state.kind === 'confirmed' ? (
          <output
            className="mt-6 block rounded-2xl border border-primary/25 bg-background px-4 py-4 text-sm leading-7"
            data-testid="cancellation-confirmed"
          >
            {state.confirmation.source === 'local-fixture' ? (
              '開発用サンプルの解約確認が完了しました。実際の契約状態は変更されていません。'
            ) : state.confirmation.outcome === 'scheduled' ? (
              <>
                次回以降の自動更新を停止しました。利用権停止事由がない限り、
                <time
                  dateTime={new Date(
                    state.confirmation.accessEndsAt,
                  ).toISOString()}
                >
                  {formatAccessEnd(state.confirmation.accessEndsAt)}
                </time>
                まで利用できます。
              </>
            ) : (
              <>
                サブスクリプションはすでに終了しています。終了日時は
                <time
                  dateTime={new Date(
                    state.confirmation.accessEndsAt,
                  ).toISOString()}
                >
                  {formatAccessEnd(state.confirmation.accessEndsAt)}
                </time>
                です。
              </>
            )}
          </output>
        ) : (
          <CancellationDialog
            state={state}
            onOpenChange={(open) =>
              dispatch({
                type: open
                  ? 'confirmation-requested'
                  : 'confirmation-cancelled',
              })
            }
            onSubmit={() => void submit()}
          />
        )}
      </section>

      <nav
        aria-label="契約管理リンク"
        className="mt-7 flex flex-wrap gap-x-5 gap-y-3 text-sm"
      >
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/checkout"
        >
          申込み内容の確認
        </PublicRouteLink>
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/legal/commercial-transactions"
        >
          特定商取引法に基づく表記
        </PublicRouteLink>
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/account/terms"
        >
          利用規約の同意状態
        </PublicRouteLink>
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/account/privacy"
        >
          個人情報に関する請求
        </PublicRouteLink>
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/"
        >
          ノートへ戻る
        </PublicRouteLink>
      </nav>
    </main>
  );
}

function CancellationDialog({
  state,
  onOpenChange,
  onSubmit,
}: {
  readonly state:
    | { readonly kind: 'idle' }
    | {
        readonly kind: 'confirming';
        readonly failure: BillingCancellationFailure | null;
      }
    | { readonly kind: 'submitting' };
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: () => void;
}) {
  const open = state.kind === 'confirming' || state.kind === 'submitting';
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Trigger
        className={buttonVariants({
          variant: 'destructive',
          size: 'lg',
          className: 'mt-6 min-h-11',
        })}
      >
        サブスクリプションを解約
      </AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/45" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <AlertDialog.Popup className="w-full max-w-md rounded-2xl border border-border bg-background p-5 text-foreground shadow-xl outline-none sm:p-6">
            <AlertDialog.Title className="text-lg font-semibold">
              サブスクリプションを解約しますか？
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">
              解約はアカウント退会とは別の手続きです。次回の自動更新を停止し、無料期間または支払済み期間の終了時までは利用できます。providerが利用終了日時を確認した場合だけ、この画面で完了として表示します。
            </AlertDialog.Description>
            {state.kind === 'confirming' && state.failure ? (
              <p
                role="alert"
                className="mt-4 text-sm leading-6 text-destructive"
              >
                {cancellationFailureMessage(state.failure)}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <AlertDialog.Close
                className={buttonVariants({ variant: 'outline', size: 'lg' })}
                disabled={state.kind === 'submitting'}
              >
                解約せず戻る
              </AlertDialog.Close>
              <Button
                type="button"
                variant="destructive"
                size="lg"
                disabled={state.kind === 'submitting'}
                onClick={onSubmit}
              >
                {state.kind === 'submitting'
                  ? '解約を確認しています'
                  : state.kind === 'confirming' &&
                      state.failure === 'unavailable'
                    ? '同じ内容で再試行'
                    : '解約を申し込む'}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function cancellationFailureMessage(failure: BillingCancellationFailure) {
  switch (failure) {
    case 'authentication-required':
      return 'ログイン状態を確認できません。ログイン後にもう一度お試しください。';
    case 'cancellation-unavailable':
      return 'このアカウントで解約可能な契約を確認できませんでした。契約状態をご確認ください。';
    case 'unavailable':
      return '解約確認を完了できませんでした。解約済みにはしていません。同じ識別子で安全に再試行できます。';
  }
}

function formatAccessEnd(timestamp: number): string {
  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Asia/Tokyo',
  }).format(new Date(timestamp));
}
