import type { Metadata } from 'next';
import {
  BillingCheckoutBoundary,
  type BillingCheckoutSource,
} from '@/components/billing-checkout-boundary';
import { billingUiOfferFromDisclosure } from '@/lib/application/billing-ui';
import { commercialDisclosureForCurrentEnvironment } from '@/lib/environment/legal-commerce';
import { legalTermsForCurrentEnvironment } from '@/lib/environment/legal-terms';

export const metadata: Metadata = {
  title: '申込み内容の最終確認 | FUKAMU Notes',
};

const localFixtureOfferHash = `sha256:${'0'.repeat(64)}`;
const localFixtureTermsHash = `sha256:${'a'.repeat(64)}`;

export default function CheckoutPage() {
  const disclosure = commercialDisclosureForCurrentEnvironment();
  const terms = legalTermsForCurrentEnvironment();
  const offer = billingUiOfferFromDisclosure(disclosure.disclosure);
  if (offer === undefined) {
    throw new Error('Legal checkout offer is unavailable');
  }
  const source: BillingCheckoutSource =
    disclosure.source === 'local-fixture'
      ? {
          kind: 'local-fixture',
          offer,
          offerHash: localFixtureOfferHash,
          terms: {
            termsVersion: terms.disclosure.termsVersion,
            termsHash: localFixtureTermsHash,
            effectiveDate: terms.disclosure.effectiveDate,
          },
        }
      : { kind: 'server' };
  return <BillingCheckoutBoundary source={source} />;
}
