import {
  billingUiOfferFromDisclosure,
  type BillingCheckoutReview,
} from '@/lib/application/billing-ui';
import type { LegalCommerceDisclosure } from '@/lib/application/legal-commerce';
import {
  parseContractEvidenceId,
  parseContractOfferHash,
  parseContractSubmissionId,
  type ContractOfferSnapshot,
} from '@/lib/contracts/contract-checkout';
import { parseTermsConsentSubmissionId } from '@/lib/contracts/terms-consent';

export const billingUiContractIds = {
  evidenceA: parseContractEvidenceId('01991f20-61d2-7000-8000-000000002301'),
  submissionA: parseContractSubmissionId(
    '01991f20-61d2-7000-8000-000000002401',
  ),
  submissionB: parseContractSubmissionId(
    '01991f20-61d2-7000-8000-000000002402',
  ),
  termsSubmissionA: parseTermsConsentSubmissionId(
    '01991f20-61d2-7000-8000-000000002501',
  ),
  termsSubmissionB: parseTermsConsentSubmissionId(
    '01991f20-61d2-7000-8000-000000002502',
  ),
  offerHashA: parseContractOfferHash(`sha256:${'a'.repeat(64)}`),
} as const;

export function billingUiDisclosureFixture(
  billingPeriod: 'monthly' | 'annual' = 'monthly',
): LegalCommerceDisclosure {
  return {
    schemaVersion: 1,
    seller: {
      legalName: '株式会社深考ノート',
      representative: '販売責任者 山田太郎',
      postalAddress: '〒100-0001 東京都千代田区千代田1-1',
      phone: '03-1234-5678',
      supportUrl: 'https://support.fukamu-notes.jp/contact',
    },
    offer: {
      planName: 'FUKAMU Notes スタンダード',
      priceYen: billingPeriod === 'monthly' ? 1_280 : 12_800,
      billingPeriod,
      taxIncluded: true,
      trialDays: 14,
    },
    additionalFees: 'インターネット接続料金は利用者の負担です。',
    cancellationPolicy:
      '契約管理画面からいつでも解約でき、現在の請求期間末に終了します。',
    refundPolicy: '支払い済み期間の日割り返金はありません。',
    specialTerms: '日本国内から利用できます。',
    systemRequirements: ['最新版のChrome、Safari、Firefox、Edge'],
    effectiveDate: '2026-09-14',
  };
}

export function billingUiContractOfferFixture(): ContractOfferSnapshot {
  const offer = billingUiOfferFromDisclosure(billingUiDisclosureFixture());
  if (offer === undefined) throw new Error('invalid billing UI fixture');
  return { schemaVersion: 1, ...offer };
}

export function billingCheckoutReviewFixture(): BillingCheckoutReview {
  return {
    offer: billingUiContractOfferFixture(),
    offerHash: billingUiContractIds.offerHashA,
    terms: {
      termsVersion: 'terms-v1:2026-09-15',
      termsHash: `sha256:${'a'.repeat(64)}`,
      effectiveDate: '2026-09-15',
    },
    submissionId: billingUiContractIds.submissionA,
    termsSubmissionId: billingUiContractIds.termsSubmissionA,
  };
}
