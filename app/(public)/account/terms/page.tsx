import type { Metadata } from 'next';
import {
  TermsConsentBoundary,
  type TermsConsentSource,
} from '@/components/terms-consent-boundary';
import { legalTermsForCurrentEnvironment } from '@/lib/environment/legal-terms';

export const metadata: Metadata = {
  title: '利用規約の確認 | FUKAMU Notes',
};

const localFixtureTermsHash = `sha256:${'a'.repeat(64)}`;

export default function AccountTermsPage() {
  const terms = legalTermsForCurrentEnvironment();
  const source: TermsConsentSource =
    terms.source === 'local-fixture'
      ? {
          kind: 'local-fixture',
          current: {
            termsVersion: terms.disclosure.termsVersion,
            termsHash: localFixtureTermsHash,
            effectiveDate: terms.disclosure.effectiveDate,
          },
        }
      : { kind: 'server' };
  return <TermsConsentBoundary source={source} />;
}
