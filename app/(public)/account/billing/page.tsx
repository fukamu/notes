import type { Metadata } from 'next';
import { BillingAccountBoundary } from '@/components/billing-account-boundary';
import { commercialDisclosureForCurrentEnvironment } from '@/lib/environment/legal-commerce';

export const metadata: Metadata = {
  title: '契約管理 | FUKAMU Notes',
};

export default function AccountBillingPage() {
  const disclosure = commercialDisclosureForCurrentEnvironment();
  return (
    <BillingAccountBoundary
      source={
        disclosure.source === 'local-fixture' ? 'local-fixture' : 'server'
      }
      cancellationPolicy={disclosure.disclosure.cancellationPolicy}
    />
  );
}
