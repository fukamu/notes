'use client';

import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { PublicRouteLink } from '@/components/public-route-link';
import { Button } from '@/components/ui/button';
import {
  initialTermsConsentUiState,
  termsConsentUiReducer,
  type TermsConsentUiFailure,
  type TermsConsentUiReference,
  type TermsConsentUiStatus,
} from '@/lib/application/terms-consent-ui';
import {
  createLocalTermsConsentUiTransport,
  createRemoteFirstTermsConsentUiTransport,
  createTermsConsentSubmissionId,
  createTermsConsentUiHttpTransport,
} from '@/lib/client/terms-consent-ui';
import type { TermsConsentSubmissionId } from '@/lib/contracts/terms-consent';

export type TermsConsentSource =
  | {
      readonly kind: 'local-fixture';
      readonly current: TermsConsentUiReference;
    }
  | { readonly kind: 'server' };

export function TermsConsentBoundary({
  source,
}: {
  readonly source: TermsConsentSource;
}) {
  const [transport] = useState(() => {
    const remote = createTermsConsentUiHttpTransport();
    return source.kind === 'local-fixture'
      ? createRemoteFirstTermsConsentUiTransport(
          createLocalTermsConsentUiTransport(source.current),
          remote,
        )
      : remote;
  });
  const [state, dispatch] = useReducer(
    termsConsentUiReducer,
    initialTermsConsentUiState,
  );
  const submissionId = useRef<TermsConsentSubmissionId | undefined>(undefined);
  const pending = useRef(false);
  const generation = useRef(0);

  const loadStatus = useCallback(
    async (termsChanged: boolean) => {
      const currentGeneration = generation.current + 1;
      generation.current = currentGeneration;
      const result = await transport.loadStatus();
      if (generation.current !== currentGeneration) return;
      if (result.kind === 'available') {
        dispatch({
          type: 'status-loaded',
          status: result.status,
          notice: termsChanged ? 'terms-changed' : null,
        });
        return;
      }
      dispatch({
        type: 'status-load-failed',
        failure:
          result.kind === 'authentication-required'
            ? 'authentication-required'
            : 'unavailable',
      });
    },
    [transport],
  );

  useEffect(() => {
    void loadStatus(false);
    return () => {
      generation.current += 1;
    };
  }, [loadStatus]);

  const accept = async (
    status: Extract<
      TermsConsentUiStatus,
      { readonly acceptanceRequired: true }
    >,
  ) => {
    if (pending.current) return;
    pending.current = true;
    dispatch({ type: 'submit-requested' });
    const stableSubmissionId =
      submissionId.current ?? createTermsConsentSubmissionId();
    submissionId.current = stableSubmissionId;
    const result = await transport.accept({
      current: status.current,
      submissionId: stableSubmissionId,
    });
    pending.current = false;
    switch (result.kind) {
      case 'accepted':
        dispatch({ type: 'accepted', status: result.status });
        return;
      case 'terms-changed':
        submissionId.current = undefined;
        dispatch({ type: 'terms-changed' });
        await loadStatus(true);
        return;
      case 'authentication-required':
        dispatch({
          type: 'submit-failed',
          failure: 'authentication-required',
        });
        return;
      case 'request-conflict':
        dispatch({ type: 'submit-failed', failure: 'request-conflict' });
        return;
      case 'not-found':
      case 'unavailable':
        dispatch({ type: 'submit-failed', failure: 'unavailable' });
        return;
    }
  };

  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <p className="text-xs font-bold tracking-[0.18em] text-muted-foreground">
        ACCOUNT / TERMS
      </p>
      <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        利用規約の確認
      </h1>
      <p className="mt-4 max-w-2xl text-sm leading-7 text-muted-foreground sm:text-base">
        現在適用される規約と同意状態を、この専用ページで確認できます。規約本文や同意操作をノート編集画面には常設しません。
      </p>

      {source.kind === 'local-fixture' ? <FixtureNotice /> : null}
      <TermsConsentPanel state={state} onAccept={accept} dispatch={dispatch} />

      <nav
        aria-label="利用規約の確認リンク"
        className="mt-7 flex flex-wrap gap-x-5 gap-y-3 text-sm"
      >
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/legal/terms"
        >
          利用規約の全文
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

function TermsConsentPanel({
  state,
  onAccept,
  dispatch,
}: {
  readonly state: ReturnType<typeof termsConsentUiReducer>;
  readonly onAccept: (
    status: Extract<
      TermsConsentUiStatus,
      { readonly acceptanceRequired: true }
    >,
  ) => Promise<void>;
  readonly dispatch: React.Dispatch<
    Parameters<typeof termsConsentUiReducer>[1]
  >;
}) {
  if (state.kind === 'loading') {
    return (
      <output className="mt-8 block text-sm text-muted-foreground">
        {state.reason === 'terms-changed'
          ? '最新の利用規約を読み直しています。'
          : '同意状態を確認しています。'}
      </output>
    );
  }
  if (state.kind === 'unavailable') {
    return (
      <p
        role="alert"
        className="mt-8 rounded-2xl border bg-card px-5 py-5 text-sm leading-7"
      >
        {state.failure === 'authentication-required'
          ? '確認にはログインが必要です。ログイン後にこのページをもう一度開いてください。'
          : '同意状態を安全に確認できません。時間をおいて再度お試しください。'}
      </p>
    );
  }

  const submitting = state.kind === 'submitting';
  const status = state.status;
  const consent = submitting ? true : state.consent;
  const failure = submitting ? null : state.failure;
  const notice = submitting ? null : state.notice;
  return (
    <section
      className="mt-8 rounded-3xl border bg-card px-6 py-7 shadow-sm sm:px-8"
      aria-labelledby="terms-status-heading"
      data-testid="terms-consent-panel"
    >
      <h2
        id="terms-status-heading"
        className="font-heading text-2xl font-semibold"
      >
        現在の同意状態
      </h2>
      <p className="mt-4 text-sm leading-7">
        <TermsStatusMessage status={status} />
      </p>
      <dl className="mt-5 grid gap-3 text-sm sm:grid-cols-[8rem_minmax(0,1fr)]">
        <dt className="font-semibold">適用版</dt>
        <dd>{status.current.termsVersion}</dd>
        <dt className="font-semibold">施行日</dt>
        <dd>{status.current.effectiveDate}</dd>
      </dl>
      <p className="mt-5 text-sm leading-7 text-muted-foreground">
        全文は{' '}
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/legal/terms"
        >
          独立した利用規約ページ
        </PublicRouteLink>
        でいつでも確認できます。
      </p>

      {notice === 'terms-changed' ? (
        <p
          role="alert"
          className="mt-5 rounded-2xl border border-amber-700/25 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
        >
          利用規約が更新されました。最新の全文を確認し、チェックを入れ直してください。
        </p>
      ) : notice === 'accepted' ? (
        <output className="mt-5 block rounded-2xl border border-primary/25 bg-background px-4 py-3 text-sm leading-6">
          現在の利用規約への同意を記録しました。
        </output>
      ) : null}

      {status.acceptanceRequired ? (
        <div className="mt-6 border-t pt-5">
          {failure ? <TermsFailureMessage failure={failure} /> : null}
          <label className="flex items-start gap-3 text-sm leading-7">
            <input
              type="checkbox"
              className="mt-1.5 size-4 shrink-0 accent-primary"
              checked={consent}
              disabled={submitting}
              onChange={(event) =>
                dispatch({
                  type: 'consent-changed',
                  consent: event.currentTarget.checked,
                })
              }
            />
            <span>
              利用規約（{status.current.termsVersion}
              ）の全文を確認し、同意します。
            </span>
          </label>
          <Button
            type="button"
            size="lg"
            className="mt-5 min-h-11 w-full whitespace-normal px-4 py-2"
            disabled={!consent || submitting}
            onClick={() => void onAccept(status)}
            data-testid="accept-current-terms"
          >
            {submitting ? '同意を記録しています' : '現在の利用規約に同意する'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

function TermsStatusMessage({
  status,
}: {
  readonly status: TermsConsentUiStatus;
}) {
  switch (status.kind) {
    case 'current':
      return '現在の利用規約への同意が必要です。';
    case 'accepted':
      return '現在の利用規約に同意済みです。';
    case 'reconsent-required':
      return '重要な改定があります。オンライン利用を続ける前に、現在の利用規約への再同意が必要です。';
    case 'notice-only':
      return '利用規約が更新されました。今回の改定について再同意は不要です。';
  }
}

function TermsFailureMessage({
  failure,
}: {
  readonly failure: TermsConsentUiFailure;
}) {
  const message =
    failure === 'authentication-required'
      ? 'ログイン状態を確認できません。ログイン後にもう一度お試しください。'
      : failure === 'request-conflict'
        ? '同じ送信識別子で異なる内容が検出されました。ページを読み直してください。'
        : '同意を記録できませんでした。同意済みにはしていません。同じ内容で安全に再試行できます。';
  return (
    <p role="alert" className="mb-4 text-sm leading-6 text-destructive">
      {message}
    </p>
  );
}

function FixtureNotice() {
  return (
    <aside
      className="mt-7 rounded-2xl border border-amber-700/25 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
      aria-label="開発用表示"
      data-testid="terms-consent-fixture-notice"
    >
      ローカル開発・テスト専用のサンプルです。同意操作を試しても本番データや契約状態は変更されません。
    </aside>
  );
}
