'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { Button, buttonVariants } from '@/components/ui/button';
import { PublicRouteLink } from '@/components/public-route-link';
import {
  billingCheckoutUiReducer,
  billingUiPeriodLabel,
  formatBillingUiYen,
  initialBillingCheckoutUiState,
  type BillingCheckoutFailure,
  type BillingCheckoutReview,
  type BillingUiOffer,
} from '@/lib/application/billing-ui';
import type { TermsConsentUiReference } from '@/lib/application/terms-consent-ui';
import {
  createBillingCheckoutSubmissionId,
  createBillingUiHttpTransport,
  type BillingOfferLoadResult,
} from '@/lib/client/http-billing-ui';
import {
  createLocalTermsConsentUiTransport,
  createTermsConsentUiHttpTransport,
  type TermsConsentStatusLoadResult,
  type TermsConsentUiTransport,
} from '@/lib/client/terms-consent-ui';

export type BillingCheckoutSource =
  | {
      readonly kind: 'local-fixture';
      readonly offer: BillingUiOffer;
      readonly offerHash: string;
      readonly terms: TermsConsentUiReference;
    }
  | { readonly kind: 'server' };

export function BillingCheckoutBoundary({
  source,
}: {
  readonly source: BillingCheckoutSource;
}) {
  const transport = useMemo(() => createBillingUiHttpTransport(), []);
  const termsTransport = useMemo(
    () =>
      source.kind === 'local-fixture'
        ? createLocalTermsConsentUiTransport(source.terms)
        : createTermsConsentUiHttpTransport(),
    [source],
  );
  const [state, dispatch] = useReducer(
    billingCheckoutUiReducer,
    initialBillingCheckoutUiState,
  );
  const pending = useRef(false);
  const loadGeneration = useRef(0);

  const loadOffer = useCallback(
    async (
      refresh: boolean,
      changed: 'offer-changed' | 'terms-changed' = 'offer-changed',
    ) => {
      const generation = loadGeneration.current + 1;
      loadGeneration.current = generation;
      const result = await resolveCheckout(
        source,
        transport.loadOffer,
        termsTransport,
        refresh,
      );
      if (generation !== loadGeneration.current) return;
      if (result.kind === 'available') {
        dispatch({
          type: 'offer-loaded',
          review: {
            offer: result.offer,
            offerHash: result.offerHash,
            terms: result.terms.current,
            submissionId: createBillingCheckoutSubmissionId(),
          },
          notice: refresh ? changed : null,
        });
        return;
      }
      dispatch({
        type: 'offer-load-failed',
        failure:
          result.kind === 'authentication-required'
            ? 'authentication-required'
            : 'unavailable',
      });
    },
    [source, termsTransport, transport],
  );

  useEffect(() => {
    void loadOffer(false);
    return () => {
      loadGeneration.current += 1;
    };
  }, [loadOffer]);

  const submit = async (review: BillingCheckoutReview) => {
    if (pending.current) return;
    pending.current = true;
    dispatch({ type: 'submit-requested' });
    const termsResult = await termsTransport.accept({
      current: review.terms,
      submissionId: review.submissionId,
    });
    if (termsResult.kind !== 'accepted') {
      pending.current = false;
      switch (termsResult.kind) {
        case 'terms-changed':
          dispatch({ type: 'terms-changed' });
          await loadOffer(true, 'terms-changed');
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
    }
    const result = await transport.submitCheckout(review);
    pending.current = false;
    switch (result.kind) {
      case 'provider-ready':
        dispatch({
          type: 'provider-ready',
          checkoutUrl: result.checkoutUrl,
          evidenceOutcome: result.evidenceOutcome,
        });
        return;
      case 'not-found':
        if (source.kind === 'local-fixture') {
          dispatch({ type: 'local-confirmed' });
          return;
        }
        dispatch({ type: 'submit-failed', failure: 'unavailable' });
        return;
      case 'offer-changed':
        dispatch({ type: 'offer-changed' });
        await loadOffer(true, 'offer-changed');
        return;
      case 'terms-changed':
        dispatch({ type: 'terms-changed' });
        await loadOffer(true, 'terms-changed');
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
      case 'unavailable':
        dispatch({ type: 'submit-failed', failure: 'unavailable' });
        return;
    }
  };

  if (state.kind === 'loading') {
    return (
      <BillingPage title="申込み内容の最終確認">
        <output className="block text-sm text-muted-foreground">
          {state.reason === 'offer-changed'
            ? '最新の申込み条件を読み直しています。'
            : state.reason === 'terms-changed'
              ? '最新の利用規約を読み直しています。'
              : '申込み条件を確認しています。'}
        </output>
      </BillingPage>
    );
  }

  if (state.kind === 'unavailable') {
    return (
      <BillingPage title="申込み内容の最終確認">
        <div
          role="alert"
          className="rounded-2xl border bg-card px-5 py-5 text-sm leading-7"
        >
          {state.failure === 'authentication-required'
            ? '申込みにはログインが必要です。ログイン後にこのページをもう一度開いてください。'
            : '申込み条件を安全に確認できないため、現在は申込みを開始できません。時間をおいて再度お試しください。'}
        </div>
        <BillingNavigation />
      </BillingPage>
    );
  }

  if (state.kind === 'provider-ready') {
    return (
      <BillingPage title="カード情報の登録へ進む">
        <output className="block rounded-2xl border bg-card px-5 py-4 text-sm leading-7">
          ここに表示した申込み内容と同意を記録しました。まだ利用権は付与されていません。Stripeでカード情報を登録し、支払い確認が完了するまでお待ちください。
        </output>
        <BillingTerms offer={state.review.offer} />
        <TermsReference current={state.review.terms} />
        <div className="mt-7 flex flex-wrap gap-3">
          <a
            className={buttonVariants({ size: 'lg' })}
            href={state.checkoutUrl}
            data-testid="hosted-checkout-link"
          >
            カード情報を登録し申込みを完了する
          </a>
          <Button
            type="button"
            size="lg"
            variant="outline"
            onClick={() => dispatch({ type: 'review-again' })}
          >
            申込み内容をもう一度確認
          </Button>
        </div>
        <p className="mt-5 text-xs leading-6 text-muted-foreground">
          ブラウザの戻る操作やStripeからのredirectだけを、契約開始・利用権付与の根拠にはしません。
        </p>
      </BillingPage>
    );
  }

  if (state.kind === 'local-confirmed') {
    return (
      <BillingPage title="開発用の申込み確認">
        <FixtureNotice />
        <output className="block rounded-2xl border bg-card px-5 py-4 text-sm leading-7">
          サンプルの確認操作が完了しました。契約、カード登録、課金、利用権の変更は行われていません。
        </output>
        <BillingTerms offer={state.review.offer} />
        <TermsReference current={state.review.terms} />
        <div className="mt-7 flex flex-wrap gap-3">
          <Button
            type="button"
            size="lg"
            variant="outline"
            onClick={() => dispatch({ type: 'review-again' })}
          >
            申込み内容をもう一度確認
          </Button>
          <PublicRouteLink
            href="/account/billing"
            className={buttonVariants({ size: 'lg', variant: 'secondary' })}
          >
            契約管理のサンプルを開く
          </PublicRouteLink>
        </div>
      </BillingPage>
    );
  }

  const submitting = state.kind === 'submitting';
  const review = state.review;
  const subscriptionConsent = submitting ? true : state.subscriptionConsent;
  const termsConsent = submitting ? true : state.termsConsent;
  const failure = submitting ? null : state.failure;
  const notice = submitting ? null : state.notice;
  return (
    <BillingPage title="申込み内容の最終確認">
      {source.kind === 'local-fixture' ? <FixtureNotice /> : null}
      {notice === 'offer-changed' ? (
        <p
          role="alert"
          className="rounded-2xl border border-amber-700/25 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
        >
          申込み条件が更新されました。最新内容を確認し、チェックを入れ直してください。
        </p>
      ) : notice === 'terms-changed' ? (
        <p
          role="alert"
          className="rounded-2xl border border-amber-700/25 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
        >
          利用規約が更新されました。最新内容を確認し、両方のチェックを入れ直してください。
        </p>
      ) : null}
      <BillingTerms offer={review.offer} />
      <TermsReference current={review.terms} />
      {failure ? <CheckoutFailureMessage failure={failure} /> : null}
      <div className="mt-7 rounded-2xl border bg-card px-5 py-5 sm:px-6">
        <label className="flex items-start gap-3 text-sm leading-7">
          <input
            type="checkbox"
            className="mt-1.5 size-4 shrink-0 accent-primary"
            checked={subscriptionConsent}
            disabled={submitting}
            onChange={(event) =>
              dispatch({
                type: 'consent-changed',
                subject: 'subscription',
                consent: event.currentTarget.checked,
              })
            }
          />
          <span>
            上記の料金、14日間の無料期間、15日目からの自動課金、解約・返金条件、支払い失敗時のオンライン停止を確認し、有料サブスクリプションの申込みに同意します。
          </span>
        </label>
        <label className="mt-4 flex items-start gap-3 border-t pt-4 text-sm leading-7">
          <input
            type="checkbox"
            className="mt-1.5 size-4 shrink-0 accent-primary"
            checked={termsConsent}
            disabled={submitting}
            onChange={(event) =>
              dispatch({
                type: 'consent-changed',
                subject: 'terms',
                consent: event.currentTarget.checked,
              })
            }
          />
          <span>
            <PublicRouteLink
              className="text-primary underline underline-offset-4"
              href="/legal/terms"
            >
              利用規約
            </PublicRouteLink>
            （{review.terms.termsVersion}）を確認し、同意します。
          </span>
        </label>
        <Button
          type="button"
          size="lg"
          className="mt-5 min-h-11 w-full whitespace-normal px-4 py-2"
          disabled={!subscriptionConsent || !termsConsent || submitting}
          onClick={() => void submit(review)}
          data-testid="confirm-subscription"
        >
          {submitting
            ? '申込み内容を記録しています'
            : '14日無料・15日目から有料で申し込む'}
        </Button>
      </div>
      <BillingNavigation />
    </BillingPage>
  );
}

function BillingPage({
  title,
  children,
}: {
  readonly title: string;
  readonly children: React.ReactNode;
}) {
  return (
    <main className="mx-auto w-full max-w-3xl px-5 py-10 sm:px-8 sm:py-14">
      <p className="text-xs font-bold tracking-[0.18em] text-muted-foreground">
        CHECKOUT
      </p>
      <h1 className="mt-3 font-heading text-3xl font-semibold tracking-tight sm:text-4xl">
        {title}
      </h1>
      <div className="mt-8 space-y-6">{children}</div>
    </main>
  );
}

function FixtureNotice() {
  return (
    <aside
      className="rounded-2xl border border-amber-700/25 bg-amber-50 px-4 py-3 text-sm leading-6 text-amber-950"
      aria-label="開発用表示"
      data-testid="billing-fixture-notice"
    >
      ローカル開発・テスト専用のサンプルです。この画面から実際の契約、カード登録、課金は行われません。
    </aside>
  );
}

function BillingTerms({ offer }: { readonly offer: BillingUiOffer }) {
  const cadence = billingUiPeriodLabel(offer.billingPeriod);
  const items = [
    ['サービス・プラン', `${offer.serviceName} / ${offer.planName}`],
    ['利用単位', '1アカウントにつき1つのPersonal Vault'],
    ['無料期間', `登録日を1日目として${offer.trialDays}日間は0円`],
    [
      '初回課金',
      `${offer.firstChargeDay}日目から${formatBillingUiYen(offer.renewalChargeYen)}。確定日はカード登録先の最終画面で確認してください。`,
    ],
    [
      '自動更新',
      `${cadence}${formatBillingUiYen(offer.renewalChargeYen)}。1年間の支払額目安は${formatBillingUiYen(offer.annualEstimateYen)}です。`,
    ],
    ['支払方法', 'クレジットカード（登録時に支払い方法を確認）'],
    [
      '提供開始・契約期間',
      '登録と支払い方法の確認後に提供開始。解約まで期間の定めなく継続します。',
    ],
    ['解約', offer.cancellationPolicy],
    ['返金・日割り', offer.refundPolicy],
    ['追加費用', offer.additionalFees],
    [
      '支払い失敗時',
      '支払い失敗または追加認証要求時はオンライン利用を停止します。カード更新だけでは再開せず、未払いinvoiceの支払い確認後に再開します。',
    ],
    [
      '解約と退会',
      'サブスクリプションの解約とアカウント退会は別の手続きです。アプリの削除やログアウトだけでは解約されません。',
    ],
  ] as const;
  return (
    <section aria-labelledby="billing-terms-title" data-testid="billing-terms">
      <h2
        id="billing-terms-title"
        className="font-heading text-2xl font-semibold"
      >
        契約条件
      </h2>
      <dl className="mt-4 overflow-hidden rounded-2xl border bg-card shadow-sm">
        {items.map(([label, value]) => (
          <div
            key={label}
            className="grid gap-1.5 border-b px-5 py-4 last:border-b-0 sm:grid-cols-[9rem_minmax(0,1fr)] sm:gap-5"
          >
            <dt className="text-sm font-semibold">{label}</dt>
            <dd className="text-sm leading-7 text-foreground/85">{value}</dd>
          </div>
        ))}
      </dl>
      <p className="mt-4 text-sm leading-7 text-muted-foreground">
        販売事業者情報などの全文は{' '}
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/legal/commercial-transactions"
        >
          特定商取引法に基づく表記
        </PublicRouteLink>
        で確認できます。
      </p>
      <p
        className="mt-3 text-sm leading-7 text-muted-foreground"
        data-testid="card-security-notice"
      >
        カード番号・セキュリティコードはStripeの画面で入力され、FUKAMU
        Notesのサーバーでは取得・保存しません。カード発行会社から本人認証（3Dセキュア）を求められる場合があります。決済事業者への送信内容は{' '}
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/legal/external-transmission"
        >
          外部送信に関する表示
        </PublicRouteLink>
        で確認できます。
      </p>
    </section>
  );
}

function TermsReference({
  current,
}: {
  readonly current: TermsConsentUiReference;
}) {
  return (
    <section
      aria-labelledby="checkout-terms-title"
      className="rounded-2xl border bg-card px-5 py-5 sm:px-6"
      data-testid="checkout-terms-reference"
    >
      <h2 id="checkout-terms-title" className="text-base font-semibold">
        利用規約
      </h2>
      <p className="mt-2 text-sm leading-7 text-muted-foreground">
        規約本文は{' '}
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/legal/terms"
        >
          独立した利用規約ページ
        </PublicRouteLink>
        で確認できます。適用版: {current.termsVersion}（{current.effectiveDate}
        ）
      </p>
    </section>
  );
}

function CheckoutFailureMessage({
  failure,
}: {
  readonly failure: BillingCheckoutFailure;
}) {
  const message =
    failure === 'authentication-required'
      ? 'ログイン状態を確認できません。ログイン後に、同じ申込み内容をもう一度送信してください。'
      : failure === 'request-conflict'
        ? '同じ申込み識別子で異なる内容が検出されました。ページを読み直して最初から確認してください。'
        : '申込み処理を完了できませんでした。入力内容は変えずに再試行できます。課金完了としては扱われていません。';
  return (
    <p
      role="alert"
      className="rounded-2xl border border-destructive/30 px-4 py-3 text-sm leading-6"
    >
      {message}
    </p>
  );
}

function BillingNavigation() {
  return (
    <nav
      aria-label="申込み操作"
      className="flex flex-wrap gap-x-5 gap-y-3 text-sm"
    >
      <PublicRouteLink
        className="text-primary underline underline-offset-4"
        href="/pricing"
      >
        料金へ戻って確認・訂正
      </PublicRouteLink>
      <PublicRouteLink
        className="text-primary underline underline-offset-4"
        href="/"
      >
        申込みを中止してノートへ戻る
      </PublicRouteLink>
    </nav>
  );
}

async function resolveOffer(
  source: BillingCheckoutSource,
  loadRemote: () => Promise<BillingOfferLoadResult>,
  refresh: boolean,
): Promise<BillingOfferLoadResult> {
  if (source.kind === 'local-fixture' && !refresh) {
    return {
      kind: 'available',
      offer: source.offer,
      offerHash: source.offerHash,
    };
  }
  const remote = await loadRemote();
  return source.kind === 'local-fixture' && remote.kind === 'not-found'
    ? {
        kind: 'available',
        offer: source.offer,
        offerHash: source.offerHash,
      }
    : remote;
}

type BillingCheckoutLoadResult =
  | {
      readonly kind: 'available';
      readonly offer: BillingUiOffer;
      readonly offerHash: string;
      readonly terms: Extract<
        TermsConsentStatusLoadResult,
        { readonly kind: 'available' }
      >['status'];
    }
  | { readonly kind: 'authentication-required' }
  | { readonly kind: 'unavailable' };

async function resolveCheckout(
  source: BillingCheckoutSource,
  loadRemoteOffer: () => Promise<BillingOfferLoadResult>,
  termsTransport: TermsConsentUiTransport,
  refresh: boolean,
): Promise<BillingCheckoutLoadResult> {
  const [offer, terms] = await Promise.all([
    resolveOffer(source, loadRemoteOffer, refresh),
    termsTransport.loadStatus(),
  ]);
  if (offer.kind === 'available' && terms.kind === 'available') {
    return { ...offer, terms: terms.status };
  }
  if (
    offer.kind === 'authentication-required' ||
    terms.kind === 'authentication-required'
  ) {
    return { kind: 'authentication-required' };
  }
  return { kind: 'unavailable' };
}
