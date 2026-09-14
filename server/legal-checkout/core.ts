import {
  decodeLegalCommerceDisclosure,
  type LegalCommerceDisclosure,
} from '../../lib/application/legal-commerce';
import type { VaultContext } from '../../lib/domain/identity';
import type {
  ContractConfirmationCommand,
  ContractEvidenceId,
  ContractEvidenceRecord,
  ContractOfferHash,
  ContractOfferSnapshot,
} from './public';

export type ContractOfferPlan =
  | { readonly kind: 'ready'; readonly offer: ContractOfferSnapshot }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-offer' };

export type ContractEvidencePlan =
  | { readonly kind: 'append'; readonly record: ContractEvidenceRecord }
  | { readonly kind: 'replay'; readonly record: ContractEvidenceRecord }
  | {
      readonly kind: 'rejected';
      readonly reason:
        | 'invalid-command'
        | 'consent-required'
        | 'stale-offer'
        | 'owner-mismatch'
        | 'identifier-conflict';
    };

export function planContractOffer(disclosure: unknown): ContractOfferPlan {
  const decoded = decodeLegalCommerceDisclosure(disclosure);
  if (decoded.kind === 'invalid') {
    return { kind: 'rejected', reason: 'invalid-offer' };
  }
  return offerFromDisclosure(decoded.disclosure);
}

export function serializeContractOffer(offer: ContractOfferSnapshot): string {
  return JSON.stringify({
    schemaVersion: offer.schemaVersion,
    offerVersion: offer.offerVersion,
    disclosureVersion: offer.disclosureVersion,
    serviceName: offer.serviceName,
    quantity: offer.quantity,
    planName: offer.planName,
    priceYen: offer.priceYen,
    billingPeriod: offer.billingPeriod,
    taxIncluded: offer.taxIncluded,
    trialDays: offer.trialDays,
    trialPriceYen: offer.trialPriceYen,
    firstChargeDay: offer.firstChargeDay,
    renewalChargeYen: offer.renewalChargeYen,
    annualEstimateYen: offer.annualEstimateYen,
    automaticRenewal: offer.automaticRenewal,
    paymentMethod: offer.paymentMethod,
    serviceStart: offer.serviceStart,
    servicePeriod: offer.servicePeriod,
    cancellationPolicy: offer.cancellationPolicy,
    refundPolicy: offer.refundPolicy,
    additionalFees: offer.additionalFees,
    onlineLockPolicy: offer.onlineLockPolicy,
    cancellationSeparateFromAccountDeletion:
      offer.cancellationSeparateFromAccountDeletion,
  });
}

export function planContractEvidence(input: {
  readonly context: VaultContext;
  readonly command: ContractConfirmationCommand;
  readonly offer: ContractOfferSnapshot;
  readonly serializedOffer: string;
  readonly authoritativeOfferHash: ContractOfferHash;
  readonly evidenceId: ContractEvidenceId;
  readonly confirmedAt: number;
  readonly existing: ContractEvidenceRecord | undefined;
}): ContractEvidencePlan {
  if (
    !validTimestamp(input.confirmedAt) ||
    input.serializedOffer !== serializeContractOffer(input.offer)
  ) {
    return { kind: 'rejected', reason: 'invalid-command' };
  }
  if (input.command.consent.kind !== 'affirmed') {
    return { kind: 'rejected', reason: 'consent-required' };
  }
  if (input.command.presentedOfferHash !== input.authoritativeOfferHash) {
    return { kind: 'rejected', reason: 'stale-offer' };
  }

  const existing = input.existing;
  if (existing !== undefined) {
    if (!sameContext(existing.scope, input.context)) {
      return { kind: 'rejected', reason: 'owner-mismatch' };
    }
    if (
      existing.submissionId !== input.command.submissionId ||
      existing.offerHash !== input.authoritativeOfferHash ||
      existing.serializedOffer !== input.serializedOffer ||
      existing.consent !== 'affirmed'
    ) {
      return { kind: 'rejected', reason: 'identifier-conflict' };
    }
    return { kind: 'replay', record: existing };
  }

  return {
    kind: 'append',
    record: {
      scope: {
        accountId: input.context.accountId,
        vaultId: input.context.vaultId,
      },
      evidenceId: input.evidenceId,
      submissionId: input.command.submissionId,
      offerHash: input.authoritativeOfferHash,
      offer: input.offer,
      serializedOffer: input.serializedOffer,
      consent: 'affirmed',
      confirmedAt: input.confirmedAt,
    },
  };
}

function offerFromDisclosure(
  disclosure: LegalCommerceDisclosure,
): ContractOfferPlan {
  const annualEstimateYen =
    disclosure.offer.billingPeriod === 'monthly'
      ? disclosure.offer.priceYen * 12
      : disclosure.offer.priceYen;
  if (
    !Number.isSafeInteger(annualEstimateYen) ||
    annualEstimateYen < disclosure.offer.priceYen
  ) {
    return { kind: 'rejected', reason: 'invalid-offer' };
  }
  return {
    kind: 'ready',
    offer: {
      schemaVersion: 1,
      offerVersion: `legal-commerce-v1:${disclosure.effectiveDate}`,
      disclosureVersion: disclosure.effectiveDate,
      serviceName: 'FUKAMU Notes',
      quantity: 'one-personal-vault',
      planName: disclosure.offer.planName,
      priceYen: disclosure.offer.priceYen,
      billingPeriod: disclosure.offer.billingPeriod,
      taxIncluded: true,
      trialDays: 14,
      trialPriceYen: 0,
      firstChargeDay: 15,
      renewalChargeYen: disclosure.offer.priceYen,
      annualEstimateYen,
      automaticRenewal: true,
      paymentMethod: 'credit-card',
      serviceStart: 'after-registration-and-payment-method-confirmation',
      servicePeriod: 'indefinite-until-cancelled',
      cancellationPolicy: disclosure.cancellationPolicy,
      refundPolicy: disclosure.refundPolicy,
      additionalFees: disclosure.additionalFees,
      onlineLockPolicy: 'immediate-on-payment-failure-or-action-required',
      cancellationSeparateFromAccountDeletion: true,
    },
  };
}

function sameContext(
  left: Pick<VaultContext, 'accountId' | 'vaultId'>,
  right: VaultContext,
): boolean {
  return left.accountId === right.accountId && left.vaultId === right.vaultId;
}

function validTimestamp(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}
