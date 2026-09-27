import { LegalDocument } from '@/components/legal-document';
import { PublicRouteLink } from '@/components/public-route-link';
import { buttonVariants } from '@/components/ui/button';
import {
  billingPeriodLabel,
  formatTaxIncludedPrice,
} from '@/lib/application/legal-commerce';
import { commercialDisclosureForCurrentEnvironment } from '@/lib/environment/legal-commerce';

export const metadata = {
  title: '料金 | FUKAMU Notes',
};

export default function PricingPage() {
  const resolved = commercialDisclosureForCurrentEnvironment();
  const disclosure = resolved.disclosure;
  return (
    <LegalDocument
      eyebrow="PRICING"
      title="料金"
      summary="FUKAMU Notesは無料プランのない有料サブスクリプションです。"
      fixture={resolved.source === 'local-fixture'}
    >
      <section
        className="rounded-3xl border bg-card px-6 py-8 shadow-sm sm:px-9"
        aria-labelledby="plan-heading"
      >
        <p className="text-sm font-medium text-muted-foreground">
          {disclosure.offer.planName}
        </p>
        <h2
          id="plan-heading"
          className="mt-2 font-heading text-3xl font-semibold"
        >
          {billingPeriodLabel(disclosure.offer.billingPeriod)}{' '}
          {formatTaxIncludedPrice(disclosure)}
        </h2>
        <p className="mt-5 text-base leading-7">
          登録日を1日目として最初の{disclosure.offer.trialDays}
          日間は無料です。登録時にクレジットカードを登録し、15日目に初回課金します。
        </p>
        <ul className="mt-6 list-disc space-y-2 pl-5 text-sm leading-7 text-foreground/85">
          <li>以後は表示された請求周期で自動更新されます。</li>
          <li>支払い失敗または追加認証要求時はオンライン利用を停止します。</li>
          <li>
            カード更新だけでは再開せず、未払いinvoiceの支払い確認後に再開します。
          </li>
          <li>{disclosure.cancellationPolicy}</li>
          <li>{disclosure.refundPolicy}</li>
        </ul>
        <p className="mt-7 text-sm text-muted-foreground">
          申込み前に{' '}
          <PublicRouteLink
            className="text-primary underline underline-offset-4"
            href="/legal/commercial-transactions"
          >
            特定商取引法に基づく表記
          </PublicRouteLink>
          をご確認ください。
        </p>
        <PublicRouteLink
          className={buttonVariants({
            size: 'lg',
            className: 'mt-7 min-h-11',
          })}
          href="/checkout"
        >
          申込み内容を確認する
        </PublicRouteLink>
      </section>

      <section className="mt-10" aria-labelledby="requirements-heading">
        <h2
          id="requirements-heading"
          className="font-heading text-2xl font-semibold"
        >
          動作環境
        </h2>
        <ul className="mt-4 list-disc space-y-2 pl-5 text-sm leading-7">
          {disclosure.systemRequirements.map((requirement) => (
            <li key={requirement}>{requirement}</li>
          ))}
        </ul>
      </section>
    </LegalDocument>
  );
}
