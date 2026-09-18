import type { Metadata } from 'next';
import { LegalDocument } from '@/components/legal-document';
import {
  browserExternalDestination,
  externalTransmissionManifest,
} from '@/lib/application/external-transmission';
import { PublicRouteLink } from '@/components/public-route-link';

export const metadata: Metadata = {
  title: '外部送信について | FUKAMU Notes',
};

export default function ExternalTransmissionPage() {
  const fixture = process.env.FUKAMU_SERVICE_MODE !== 'public-paid';

  return (
    <LegalDocument
      eyebrow="EXTERNAL TRANSMISSION"
      title="外部送信について"
      summary="FUKAMU Notesから外部serviceへ遷移するときに送信される情報、送信先と利用目的を説明します。"
      fixture={fixture}
      fixtureMessage="これはローカル開発・テスト環境の表示です。この環境ではGoogle LoginとStripe Checkoutへの実接続を行いません。"
    >
      <div className="space-y-7">
        <section className="rounded-2xl border bg-card px-5 py-5 text-sm leading-7 shadow-sm sm:px-7">
          <h2 className="font-semibold">現在の方針</h2>
          <p className="mt-2 text-foreground/85">
            広告、行動分析またはerror
            monitoringのための第三者tag・SDKは読み込んでいません。以下の送信は、利用者がGoogle
            LoginまたはStripe
            Checkoutを選択した場合に限って発生します。通常のcard編集、履歴またはつながり表示だけで第三者へ利用者contentを送信することはありません。
          </p>
          <p className="mt-2 text-foreground/85">
            認証には必要なfirst-party Cookie「
            {externalTransmissionManifest.firstPartySession.cookieName}
            」を使用し、FUKAMU
            Notesと同じoriginにだけ送信します。IndexedDBとCache
            Storageはlocal-first・offline利用に使用し、logout時は当該利用者のlocal
            contentを削除します。FUKAMU Notesがthird-party
            Cookieを設定することはありません。
          </p>
          <p className="mt-2 text-foreground/85">
            本ページは、電気通信事業法上の外部送信規律の適用有無にかかわらず、確認しやすいよう公表するものです。production公開前に、本serviceの具体的構成について資格ある専門家または管轄総合通信局へ確認します。
          </p>
        </section>

        {externalTransmissionManifest.entries.map((entry) => {
          const destination = browserExternalDestination(entry.destinationId);
          return (
            <section
              className="overflow-hidden rounded-2xl border bg-card shadow-sm"
              key={entry.destinationId}
            >
              <div className="border-b px-5 py-4 sm:px-7">
                <h2 className="font-heading text-xl font-semibold">
                  {entry.serviceName}
                </h2>
                <p className="mt-1 break-all text-sm text-muted-foreground">
                  送信先origin: {destination.origin}
                </p>
              </div>
              <dl className="divide-y">
                <DisclosureItem label="送信先を運営する者">
                  {entry.recipientLegalNames.join('、')}
                </DisclosureItem>
                <DisclosureItem label="送信のタイミング">
                  利用者が{destination.feature}への遷移を選択したとき
                </DisclosureItem>
                <DisclosureItem label="送信される情報">
                  <DisclosureList items={entry.sentInformation} />
                </DisclosureItem>
                <DisclosureItem label="FUKAMU Notesでの利用目的">
                  <DisclosureList items={entry.operatorPurposes} />
                </DisclosureItem>
                <DisclosureItem label="送信先での利用目的">
                  <DisclosureList items={entry.recipientPurposes} />
                </DisclosureItem>
                <DisclosureItem label="送信しない場合の影響">
                  {entry.refusalEffect}
                </DisclosureItem>
                <DisclosureItem label="送信先のprivacy情報">
                  <a
                    className="break-all text-primary underline underline-offset-4"
                    href={entry.privacyUrl}
                    rel="noreferrer"
                  >
                    {entry.serviceName}のprivacy情報
                  </a>
                </DisclosureItem>
              </dl>
            </section>
          );
        })}

        <p className="text-sm leading-7 text-muted-foreground">
          個人情報全般の取扱いは
          <PublicRouteLink
            className="mx-1 text-primary underline underline-offset-4"
            href="/legal/privacy"
          >
            個人情報保護方針
          </PublicRouteLink>
          をご覧ください。送信先や利用目的を変更する場合は、本ページとmanifestを同時に更新します。
        </p>
        <p className="text-xs text-muted-foreground">
          version: {externalTransmissionManifest.manifestVersion} / reviewed:{' '}
          {externalTransmissionManifest.reviewedOn}
        </p>
      </div>
    </LegalDocument>
  );
}

function DisclosureItem({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2 px-5 py-5 sm:grid-cols-[12rem_minmax(0,1fr)] sm:gap-6 sm:px-7">
      <dt className="text-sm font-semibold">{label}</dt>
      <dd className="min-w-0 text-sm leading-7 text-foreground/85">
        {children}
      </dd>
    </div>
  );
}

function DisclosureList({ items }: { items: readonly string[] }) {
  return (
    <ul className="list-disc space-y-1 pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  );
}
