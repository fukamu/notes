import type { Metadata } from 'next';
import { PrivacyRequestBoundary } from '@/components/privacy-request-boundary';
import { privacyDisclosureForCurrentEnvironment } from '@/lib/environment/privacy-disclosure';

export const metadata: Metadata = {
  title: '個人情報に関する請求 | FUKAMU Notes',
};

export default function AccountPrivacyPage() {
  const resolved = privacyDisclosureForCurrentEnvironment();
  const request = resolved.disclosure.dataSubjectRequests;
  return (
    <PrivacyRequestBoundary
      source={resolved.source === 'local-fixture' ? 'local-fixture' : 'server'}
      procedure={request.procedure}
      identityVerification={request.identityVerification}
      fee={request.fee}
    />
  );
}
