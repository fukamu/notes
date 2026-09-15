import type { Metadata } from 'next';
import {
  LegalDefinitionList,
  LegalDocument,
} from '@/components/legal-document';
import { PublicRouteLink } from '@/components/public-route-link';
import { privacyRequestKindLabel } from '@/lib/application/privacy-disclosure';
import { privacyDisclosureForCurrentEnvironment } from '@/lib/environment/privacy-disclosure';

export const metadata: Metadata = {
  title: '個人情報保護方針 | FUKAMU Notes',
};

export default function PrivacyPage() {
  const resolved = privacyDisclosureForCurrentEnvironment();
  const disclosure = resolved.disclosure;

  return (
    <LegalDocument
      eyebrow="PRIVACY"
      title="個人情報保護方針"
      summary="FUKAMU Notesにおける個人情報の取得、利用、保存、安全管理および本人からの請求について説明します。"
      fixture={resolved.source === 'local-fixture'}
      fixtureMessage="これはローカル開発・テスト専用のサンプル方針です。実在する運営者、窓口、委託先または本番の取扱条件を示すものではありません。"
    >
      <LegalDefinitionList
        items={[
          {
            label: '個人情報取扱事業者',
            value: disclosure.controller.legalName,
          },
          { label: '代表者', value: disclosure.controller.representative },
          { label: '所在地', value: disclosure.controller.postalAddress },
          {
            label: '取得する情報・取得元・利用目的',
            value: (
              <div className="space-y-5">
                {disclosure.collection.map((item) => (
                  <section key={item.category}>
                    <h2 className="font-semibold text-foreground">
                      {item.category}
                    </h2>
                    <p className="mt-1">取得元：{item.source}</p>
                    <ul className="mt-1 list-disc space-y-1 pl-5">
                      {item.purposes.map((purpose) => (
                        <li key={purpose}>{purpose}</li>
                      ))}
                    </ul>
                  </section>
                ))}
              </div>
            ),
          },
          {
            label: 'Personal Vaultと利用者content',
            value: disclosure.userContentNotice,
          },
          { label: '端末内の保存', value: disclosure.localDeviceHandling },
          {
            label: '保存期間・削除',
            value: (
              <div className="space-y-2">
                <p>{disclosure.retention.accountAndBilling}</p>
                <p>{disclosure.retention.vaultContent}</p>
                <p>
                  logout時はその利用者の端末内contentを削除し、退会時はlive
                  dataを削除します。backup等への残存期間は最大
                  {disclosure.retention.backupMaximumDays}日です。
                </p>
              </div>
            ),
          },
          {
            label: '安全管理措置の概要',
            value: (
              <ul className="list-disc space-y-1 pl-5">
                {disclosure.securityMeasures.map((measure) => (
                  <li key={measure}>{measure}</li>
                ))}
              </ul>
            ),
          },
          {
            label: '委託・第三者提供',
            value: disclosure.processorsAndThirdParties,
          },
          {
            label: '外部送信',
            value: (
              <div className="space-y-2">
                <p>
                  Google LoginとStripe
                  Checkoutへの遷移時に送信される情報、送信先および利用目的は、独立した公表ページで確認できます。
                </p>
                <PublicRouteLink
                  className="inline-block text-primary underline underline-offset-4"
                  href="/legal/external-transmission"
                >
                  外部送信について確認する
                </PublicRouteLink>
              </div>
            ),
          },
          { label: '外国での取扱い', value: disclosure.foreignTransfers },
          {
            label: '本人からの請求',
            value: (
              <div className="space-y-3">
                <ul className="list-disc space-y-1 pl-5">
                  {disclosure.dataSubjectRequests.availableActions.map(
                    (action) => (
                      <li key={action}>{privacyRequestKindLabel(action)}</li>
                    ),
                  )}
                </ul>
                <p>{disclosure.dataSubjectRequests.procedure}</p>
                <p>{disclosure.dataSubjectRequests.identityVerification}</p>
                <p>{disclosure.dataSubjectRequests.fee}</p>
                <PublicRouteLink
                  className="inline-block text-primary underline underline-offset-4"
                  href="/account/privacy"
                >
                  専用accountページで請求する
                </PublicRouteLink>
              </div>
            ),
          },
          {
            label: 'お問い合わせ・請求窓口',
            value: (
              <a
                className="break-all text-primary underline underline-offset-4"
                href={disclosure.dataSubjectRequests.contactUrl}
              >
                個人情報に関する窓口
              </a>
            ),
          },
          { label: '方針の変更', value: disclosure.policyChanges },
          {
            label: '制定・改定',
            value: `${disclosure.effectiveDate}（${disclosure.policyVersion}）`,
          },
        ]}
      />
    </LegalDocument>
  );
}
