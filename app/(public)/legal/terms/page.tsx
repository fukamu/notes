import type { Metadata } from 'next';
import {
  LegalDefinitionList,
  LegalDocument,
} from '@/components/legal-document';
import { legalTermsForCurrentEnvironment } from '@/lib/environment/legal-terms';

export const metadata: Metadata = {
  title: '利用規約 | FUKAMU Notes',
};

export default function LegalTermsPage() {
  const resolved = legalTermsForCurrentEnvironment();
  const terms = resolved.disclosure;
  return (
    <LegalDocument
      eyebrow="TERMS"
      title="利用規約"
      summary="FUKAMU Notesのアカウント、Personal Vault、有料サブスクリプションおよび利用者contentの取扱条件です。"
      fixture={resolved.source === 'local-fixture'}
      fixtureMessage="これはローカル開発・テスト専用のサンプル規約です。実在する契約条件、責任範囲、対象年齢、通知期間または裁判管轄を確定するものではありません。"
    >
      <LegalDefinitionList
        items={[
          {
            label: 'サービス・運営者',
            value: `${terms.serviceName} / ${terms.operator.legalName}`,
          },
          { label: '利用資格', value: terms.serviceEligibility },
          { label: 'アカウントと認証', value: terms.accountSecurity },
          {
            label: '認証・Vaultの前提',
            value:
              'Google LoginまたはEmail OTPを利用し、パスワード認証と共有Vaultは提供しません。1 Accountにつき1 Personal Vaultです。',
          },
          {
            label: '禁止行為',
            value: (
              <ul className="list-disc space-y-1 pl-5">
                {terms.prohibitedActivities.map((activity) => (
                  <li key={activity}>{activity}</li>
                ))}
              </ul>
            ),
          },
          {
            label: '利用者content',
            value: terms.userContent.licensePurpose,
          },
          {
            label: '料金・無料期間・更新',
            value: `有料serviceです。登録日を1日目として${terms.billing.trialDays}日間は無料で、${terms.billing.firstChargeDay}日目から自動課金へ移行します。`,
          },
          { label: '解約', value: terms.billing.cancellationPolicy },
          { label: '返金', value: terms.billing.refundPolicy },
          {
            label: '支払い停止時',
            value:
              '支払い失敗または追加認証要求時はオンライン利用を停止します。カード更新だけでは再開せず、未払いinvoiceの支払い確認後に再開します。',
          },
          {
            label: 'logout・退会・data削除',
            value: `logout時はその利用者のlocal contentを削除し、退会時はlive dataを削除します。backup等への残存期間は最大${terms.dataHandling.backupMaximumDays}日です。subscription解約と退会は別手続きです。`,
          },
          { label: '利用停止', value: terms.suspensionPolicy },
          { label: '保守・変更', value: terms.maintenanceAndChanges },
          { label: 'サービス終了', value: terms.serviceTermination },
          { label: '知的財産権', value: terms.intellectualProperty },
          { label: '責任・損害', value: terms.liability },
          { label: '通知', value: terms.notices },
          { label: '準拠法・裁判管轄', value: terms.governingLawAndVenue },
          { label: '規約の変更', value: terms.amendments.procedure },
          {
            label: 'お問い合わせ',
            value: (
              <a
                className="break-all text-primary underline underline-offset-4"
                href={terms.operator.supportUrl}
              >
                運営者・契約に関する窓口
              </a>
            ),
          },
          {
            label: 'version・施行日',
            value: `${terms.termsVersion} / ${terms.effectiveDate}`,
          },
        ]}
      />
    </LegalDocument>
  );
}
