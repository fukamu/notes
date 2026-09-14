import type { LegalCommerceDisclosure } from '@/lib/application/legal-commerce';
import {
  planContractOffer,
  serializeContractOffer,
} from '@/server/legal-checkout/core';
import {
  parseContractEvidenceId,
  parseContractOfferHash,
  parseContractSubmissionId,
  type ContractConfirmationCommand,
  type ContractEvidenceRecord,
} from '@/server/legal-checkout/public';
import { billingContext } from '@/tests/fixtures/billing';

export const contractIds = {
  evidenceA: parseContractEvidenceId('01991f20-61d2-7000-8000-000000002301'),
  evidenceB: parseContractEvidenceId('01991f20-61d2-7000-8000-000000002302'),
  submissionA: parseContractSubmissionId(
    '01991f20-61d2-7000-8000-000000002401',
  ),
  submissionB: parseContractSubmissionId(
    '01991f20-61d2-7000-8000-000000002402',
  ),
  offerHashA: parseContractOfferHash(`sha256:${'a'.repeat(64)}`),
  offerHashB: parseContractOfferHash(`sha256:${'b'.repeat(64)}`),
} as const;

export function contractDisclosure(
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

export function contractCommand(
  overrides: Partial<ContractConfirmationCommand> = {},
): ContractConfirmationCommand {
  return {
    submissionId: contractIds.submissionA,
    presentedOfferHash: contractIds.offerHashA,
    consent: { kind: 'affirmed' },
    ...overrides,
  };
}

export function contractEvidence(
  overrides: Partial<ContractEvidenceRecord> = {},
): ContractEvidenceRecord {
  const offerPlan = planContractOffer(contractDisclosure());
  if (offerPlan.kind !== 'ready') throw new Error('invalid contract fixture');
  return {
    scope: {
      accountId: billingContext().accountId,
      vaultId: billingContext().vaultId,
    },
    evidenceId: contractIds.evidenceA,
    submissionId: contractIds.submissionA,
    offerHash: contractIds.offerHashA,
    offer: offerPlan.offer,
    serializedOffer: serializeContractOffer(offerPlan.offer),
    consent: 'affirmed',
    confirmedAt: 1_000,
    ...overrides,
  };
}
