import type { StripeBillingAdapter } from '../stripe/public';
import { planContractHostedCheckout } from './checkout-core';
import type {
  ContractCheckoutApplication,
  ContractCheckoutResult,
  ContractEvidenceService,
  ContractOfferSourcePort,
  PrepareContractOfferResult,
} from './public';

export function createContractCheckoutApplication(dependencies: {
  readonly evidence: ContractEvidenceService;
  readonly offerSource: ContractOfferSourcePort;
  readonly provider: Pick<StripeBillingAdapter, 'beginHostedCheckout'>;
}): ContractCheckoutApplication {
  function readOffer():
    | { readonly kind: 'read'; readonly value: unknown }
    | { readonly kind: 'unavailable' } {
    try {
      return { kind: 'read', value: dependencies.offerSource.readCurrent() };
    } catch {
      return { kind: 'unavailable' };
    }
  }

  return {
    async prepareOffer(): Promise<PrepareContractOfferResult> {
      const offer = readOffer();
      if (offer.kind === 'unavailable') {
        return { kind: 'unavailable', reason: 'invalid-offer' };
      }
      try {
        return await dependencies.evidence.prepareOffer(offer.value);
      } catch {
        return { kind: 'unavailable', reason: 'hash-unavailable' };
      }
    },

    async confirm(input): Promise<ContractCheckoutResult> {
      const offer = readOffer();
      if (offer.kind === 'unavailable') {
        return { kind: 'rejected', reason: 'invalid-offer' };
      }
      let confirmation;
      try {
        confirmation = await dependencies.evidence.confirm({
          ...input,
          disclosure: offer.value,
        });
      } catch {
        return { kind: 'rejected', reason: 'unavailable' };
      }
      if (confirmation.kind === 'rejected') return confirmation;

      const checkout = planContractHostedCheckout({
        evidence: confirmation.evidence,
        createdAt: input.confirmedAt,
      });
      if (checkout.kind === 'rejected') return checkout;

      let providerResult;
      try {
        providerResult = await dependencies.provider.beginHostedCheckout(
          input.context,
          checkout.command,
        );
      } catch {
        return { kind: 'rejected', reason: 'provider-unavailable' };
      }
      if (providerResult.kind === 'rejected') {
        const reason = providerResult.reason;
        if (reason === 'invalid-input') {
          return { kind: 'rejected', reason: 'invalid-command' };
        }
        return { kind: 'rejected', reason };
      }
      return {
        kind: 'redirect',
        evidenceOutcome: confirmation.outcome,
        evidence: confirmation.evidence,
        checkoutUrl: providerResult.checkoutUrl,
      };
    },
  };
}
