'use client';

import { AlertDialog } from '@base-ui/react/alert-dialog';
import { useEffect, useMemo, useReducer, useRef } from 'react';
import { PublicRouteLink } from '@/components/public-route-link';
import { Button, buttonVariants } from '@/components/ui/button';
import {
  initialPrivacyRequestUiState,
  privacyRequestStatusPresentation,
  privacyRequestUiReducer,
  type PrivacyRequestUiCommand,
  type PrivacyRequestUiFailure,
} from '@/lib/application/privacy-request-ui';
import { privacyRequestKindLabel } from '@/lib/application/privacy-disclosure';
import {
  createPrivacyRequestSubmissionId,
  createPrivacyRequestUiHttpTransport,
  type PrivacyRequestUiTransport,
} from '@/lib/client/http-privacy-request';
import { createLocalPrivacyRequestUiTransport } from '@/lib/client/local-privacy-request';
import { privacyRequestKinds } from '@/lib/domain/privacy-request';

export function PrivacyRequestBoundary({
  source,
  procedure,
  identityVerification,
  fee,
}: {
  readonly source: 'local-fixture' | 'server';
  readonly procedure: string;
  readonly identityVerification: string;
  readonly fee: string;
}) {
  const transport = useMemo<PrivacyRequestUiTransport>(
    () =>
      source === 'local-fixture'
        ? createLocalPrivacyRequestUiTransport()
        : createPrivacyRequestUiHttpTransport(),
    [source],
  );
  const [state, dispatch] = useReducer(
    privacyRequestUiReducer,
    initialPrivacyRequestUiState,
  );
  const pending = useRef(false);
  const operationEpoch = useRef(0);

  useEffect(() => {
    const resetRestoredPage = (event: PageTransitionEvent) => {
      if (event.persisted) {
        operationEpoch.current += 1;
        pending.current = false;
        dispatch({ type: 'page-reentered' });
      }
    };
    window.addEventListener('pageshow', resetRestoredPage);
    return () => window.removeEventListener('pageshow', resetRestoredPage);
  }, []);

  const submit = async (command: PrivacyRequestUiCommand) => {
    if (pending.current) return;
    const epoch = operationEpoch.current;
    pending.current = true;
    dispatch({
      type: 'submission-requested',
      newSubmissionId: command.submissionId,
    });
    const result = await transport.submit(command);
    if (epoch !== operationEpoch.current) return;
    pending.current = false;
    dispatch(
      result.kind === 'accepted'
        ? { type: 'submission-accepted', request: result.request }
        : { type: 'submission-failed', failure: result.reason },
    );
  };

  const submitDraft = () => {
    if (state.kind !== 'draft') return;
    const command = {
      submissionId:
        state.retrySubmissionId ?? createPrivacyRequestSubmissionId(),
      requestKind: state.requestKind,
    };
    if (state.requestKind === 'deletion' && state.confirmation !== 'open') {
      dispatch({ type: 'confirmation-requested' });
      return;
    }
    void submit(command);
  };

  const refresh = async () => {
    if (state.kind !== 'tracking' || pending.current) return;
    const epoch = operationEpoch.current;
    pending.current = true;
    const tracked = state.request;
    dispatch({ type: 'refresh-requested' });
    const result = await transport.status({ requestId: tracked.requestId });
    if (epoch !== operationEpoch.current) return;
    pending.current = false;
    dispatch(
      result.kind === 'accepted'
        ? { type: 'refresh-accepted', request: result.request }
        : { type: 'refresh-failed', failure: result.reason },
    );
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <p className="text-xs font-bold tracking-[0.18em] text-muted-foreground">
        ACCOUNT / PRIVACY
      </p>
      <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        個人情報に関する請求
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
        個人情報に関する請求を、この専用ページから受け付けます。ノートの編集画面には請求フォームや確認ダイアログを常設しません。
      </p>

      {source === 'local-fixture' ? (
        <aside
          className="mt-7 rounded-2xl border border-amber-700/25 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
          aria-label="開発用表示"
          data-testid="privacy-request-fixture-notice"
        >
          ローカル開発・テスト専用の画面です。操作しても本人確認、データ開示・変更・削除、退会は行われず、受付内容はブラウザへ保存されません。
        </aside>
      ) : null}

      <section
        className="mt-8 rounded-3xl border bg-card px-6 py-7 shadow-sm sm:px-8"
        aria-labelledby="privacy-request-heading"
      >
        <h2
          id="privacy-request-heading"
          className="font-heading text-2xl font-semibold"
        >
          請求手続き
        </h2>
        <div className="mt-4 space-y-2 text-sm leading-7 text-foreground/85">
          <p>{procedure}</p>
          <p>{identityVerification}</p>
          <p>{fee}</p>
        </div>

        {state.kind === 'tracking' ? (
          <RequestStatus
            state={state}
            onRefresh={() => void refresh()}
            onAnother={() => dispatch({ type: 'another-request-requested' })}
          />
        ) : (
          <form
            className="mt-7"
            onSubmit={(event) => {
              event.preventDefault();
              submitDraft();
            }}
          >
            <label
              className="block text-sm font-semibold"
              htmlFor="privacy-request-kind"
            >
              請求内容
            </label>
            <select
              id="privacy-request-kind"
              className="mt-2 min-h-11 w-full rounded-lg border border-input bg-background px-3 py-2 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
              value={state.kind === 'draft' ? state.requestKind : ''}
              disabled={state.kind === 'submitting'}
              onChange={(event) => {
                const requestKind = privacyRequestKinds.find(
                  (candidate) => candidate === event.currentTarget.value,
                );
                if (requestKind !== undefined) {
                  dispatch({ type: 'request-kind-selected', requestKind });
                }
              }}
            >
              {privacyRequestKinds.map((kind) => (
                <option key={kind} value={kind}>
                  {privacyRequestKindLabel(kind)}
                </option>
              ))}
            </select>

            {state.kind === 'draft' && state.failure ? (
              <p
                role="alert"
                className="mt-4 text-sm leading-6 text-destructive"
              >
                {failureMessage(state.failure)}
              </p>
            ) : null}

            <Button
              type="submit"
              size="lg"
              className="mt-5 min-h-11"
              disabled={state.kind === 'submitting'}
              data-testid="submit-privacy-request"
            >
              {state.kind === 'submitting'
                ? '受付を確認しています'
                : state.kind === 'draft' && state.retrySubmissionId !== null
                  ? '同じ内容で再試行'
                  : state.kind === 'draft' && state.requestKind === 'deletion'
                    ? '退会・削除請求を確認'
                    : 'この内容で請求する'}
            </Button>

            {state.kind === 'draft' ? (
              <DeletionConfirmation
                open={state.confirmation === 'open'}
                retry={state.retrySubmissionId !== null}
                onOpenChange={(open) =>
                  dispatch({
                    type: open
                      ? 'confirmation-requested'
                      : 'confirmation-cancelled',
                  })
                }
                onSubmit={submitDraft}
              />
            ) : null}
          </form>
        )}
      </section>

      <nav
        aria-label="個人情報に関するリンク"
        className="mt-7 flex flex-wrap gap-x-5 gap-y-3 text-sm"
      >
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/legal/privacy"
        >
          個人情報保護方針
        </PublicRouteLink>
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/account/billing"
        >
          契約管理
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

function RequestStatus({
  state,
  onRefresh,
  onAnother,
}: {
  readonly state: Extract<
    ReturnType<typeof privacyRequestUiReducer>,
    { readonly kind: 'tracking' }
  >;
  readonly onRefresh: () => void;
  readonly onAnother: () => void;
}) {
  const presentation = privacyRequestStatusPresentation(state.request);
  return (
    <section className="mt-7 rounded-2xl border bg-background px-4 py-5 sm:px-5">
      <p className="text-sm font-semibold">
        {privacyRequestKindLabel(state.request.requestKind)}
      </p>
      <output className="mt-2 block text-lg font-semibold">
        {presentation.label}
      </output>
      <p className="mt-2 text-sm leading-7 text-muted-foreground">
        {presentation.detail}
      </p>
      <p className="mt-3 break-all text-xs text-muted-foreground">
        受付番号: {state.request.requestId}
      </p>
      {state.failure ? (
        <p role="alert" className="mt-4 text-sm leading-6 text-destructive">
          {failureMessage(state.failure)}
        </p>
      ) : null}
      <div className="mt-5 flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          size="lg"
          disabled={state.refresh === 'refreshing'}
          onClick={onRefresh}
        >
          {state.refresh === 'refreshing' ? '状態を確認中' : '最新状態を確認'}
        </Button>
        <Button type="button" variant="ghost" size="lg" onClick={onAnother}>
          別の請求を行う
        </Button>
      </div>
    </section>
  );
}

function DeletionConfirmation({
  open,
  retry,
  onOpenChange,
  onSubmit,
}: {
  readonly open: boolean;
  readonly retry: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-50 bg-black/45" />
        <AlertDialog.Viewport className="fixed inset-0 z-50 grid place-items-center p-4">
          <AlertDialog.Popup className="w-full max-w-md rounded-2xl border border-border bg-background p-5 text-foreground shadow-xl outline-none sm:p-6">
            <AlertDialog.Title className="text-lg font-semibold">
              退会・live dataの削除を請求しますか？
            </AlertDialog.Title>
            <AlertDialog.Description className="mt-2 text-sm leading-6 text-muted-foreground">
              これは退会とlive
              data削除の受付です。本人確認後に既存の退会処理へ引き継ぎ、受付だけで直ちに削除完了とは扱いません。
            </AlertDialog.Description>
            <div className="mt-5 flex flex-wrap justify-end gap-2">
              <AlertDialog.Close
                className={buttonVariants({ variant: 'outline', size: 'lg' })}
              >
                請求せず戻る
              </AlertDialog.Close>
              <Button
                type="button"
                variant="destructive"
                size="lg"
                onClick={onSubmit}
              >
                {retry ? '同じ削除請求で再試行' : '退会・削除を請求する'}
              </Button>
            </div>
          </AlertDialog.Popup>
        </AlertDialog.Viewport>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

function failureMessage(failure: PrivacyRequestUiFailure): string {
  switch (failure) {
    case 'authentication-required':
      return 'ログイン状態を確認できません。ログイン後にもう一度お試しください。';
    case 'request-conflict':
      return '同じ受付識別子に異なる内容が指定されました。請求内容を確認してください。';
    case 'not-found':
      return 'この受付を現在のアカウントで確認できませんでした。';
    case 'unavailable':
      return '受付を完了できませんでした。完了として扱っていません。同じ識別子で安全に再試行できます。';
  }
}
