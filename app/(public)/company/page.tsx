import type { Metadata } from 'next';
import {
  LegalDefinitionList,
  LegalDocument,
} from '@/components/legal-document';
import { PublicRouteLink } from '@/components/public-route-link';
import { commercialDisclosureForCurrentEnvironment } from '@/lib/environment/legal-commerce';

export const metadata: Metadata = {
  title: '会社概要 | FUKAMU Notes',
};

export default function CompanyPage() {
  const resolved = commercialDisclosureForCurrentEnvironment();
  const disclosure = resolved.disclosure;
  return (
    <LegalDocument
      eyebrow="COMPANY"
      title="会社概要"
      summary="FUKAMU Notesを運営する事業者の公開情報です。"
      fixture={resolved.source === 'local-fixture'}
    >
      <LegalDefinitionList
        items={[
          { label: '会社名', value: disclosure.seller.legalName },
          { label: '責任者', value: disclosure.seller.representative },
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
        ]}
      />
      <p className="mt-6 text-sm leading-7 text-muted-foreground">
        販売条件の詳細は{' '}
        <PublicRouteLink
          className="text-primary underline underline-offset-4"
          href="/legal/commercial-transactions"
        >
          特定商取引法に基づく表記
        </PublicRouteLink>
        をご確認ください。
      </p>
    </LegalDocument>
  );
}
