import type { Metadata } from 'next';
import {
  LegalDefinitionList,
  LegalDocument,
} from '@/components/legal-document';
import {
  billingPeriodLabel,
  formatTaxIncludedPrice,
} from '@/lib/application/legal-commerce';
import { commercialDisclosureForCurrentEnvironment } from '@/lib/environment/legal-commerce';

export const metadata: Metadata = {
  title: '特定商取引法に基づく表記 | FUKAMU Notes',
};

export default function CommercialTransactionsPage() {
  const resolved = commercialDisclosureForCurrentEnvironment();
  const disclosure = resolved.disclosure;
  const price = `${billingPeriodLabel(disclosure.offer.billingPeriod)} ${formatTaxIncludedPrice(disclosure)}`;

  return (
    <LegalDocument
      eyebrow="LEGAL"
      title="特定商取引法に基づく表記"
      summary="FUKAMU Notesの有料サブスクリプションに関する販売条件と事業者情報です。"
      fixture={resolved.source === 'local-fixture'}
    >
      <LegalDefinitionList
        items={[
          { label: '販売事業者', value: disclosure.seller.legalName },
          {
            label: '運営責任者',
            value: disclosure.seller.representative,
          },
          { label: '所在地', value: disclosure.seller.postalAddress },
          { label: '電話番号', value: disclosure.seller.phone },
          {
            label: 'お問い合わせ',
            value: (
              <a
                className="break-all text-primary underline underline-offset-4"
                href={disclosure.seller.supportUrl}
              >
                お問い合わせ窓口
              </a>
            ),
          },
          {
            label: '販売価格',
            value: `${disclosure.offer.planName}：${price}`,
          },
          { label: '価格以外の負担', value: disclosure.additionalFees },
          {
            label: '支払方法',
            value: 'クレジットカード。登録時に支払い方法の登録が必要です。',
          },
          {
            label: '支払時期',
            value: `登録日を1日目として最初の${disclosure.offer.trialDays}日間は無料です。15日目に初回課金し、以後は表示された請求周期で自動課金します。`,
          },
          {
            label: 'サービス提供時期',
            value:
              '登録と支払い方法の確認後に利用を開始できます。支払い失敗または追加認証要求時はオンライン利用を停止します。',
          },
          {
            label: '継続条件',
            value: `${billingPeriodLabel(disclosure.offer.billingPeriod)}の自動更新です。カード更新だけでは支払い停止を解除せず、未払いinvoiceの支払い確認後に再開します。`,
          },
          { label: '解約', value: disclosure.cancellationPolicy },
          { label: '返金', value: disclosure.refundPolicy },
          { label: '特別条件', value: disclosure.specialTerms },
          {
            label: '動作環境',
            value: (
              <ul className="list-disc space-y-1 pl-5">
                {disclosure.systemRequirements.map((requirement) => (
                  <li key={requirement}>{requirement}</li>
                ))}
              </ul>
            ),
          },
          { label: '制定日', value: disclosure.effectiveDate },
        ]}
      />
    </LegalDocument>
  );
}
