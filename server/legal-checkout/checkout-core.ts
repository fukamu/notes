import {
  billingSubscriptionIdDecoder,
  checkoutIntentIdDecoder,
} from '../billing/public';
import type { HostedCheckoutCommand } from '../stripe/public';
import type { ContractEvidenceRecord } from './public';

export type ContractHostedCheckoutPlan =
  | { readonly kind: 'ready'; readonly command: HostedCheckoutCommand }
  | { readonly kind: 'rejected'; readonly reason: 'invalid-command' };

export function planContractHostedCheckout(input: {
  readonly evidence: ContractEvidenceRecord;
  readonly createdAt: number;
}): ContractHostedCheckoutPlan {
  if (!Number.isSafeInteger(input.createdAt) || input.createdAt < 0) {
    return { kind: 'rejected', reason: 'invalid-command' };
  }
  const subscriptionId = billingSubscriptionIdDecoder.decode(
    input.evidence.evidenceId,
  );
  const checkoutIntentId = checkoutIntentIdDecoder.decode(
    input.evidence.submissionId,
  );
  if (!subscriptionId.ok || !checkoutIntentId.ok) {
    return { kind: 'rejected', reason: 'invalid-command' };
  }
  return {
    kind: 'ready',
    command: {
      subscriptionId: subscriptionId.value,
      checkoutIntentId: checkoutIntentId.value,
      createdAt: input.createdAt,
      contract: {
        evidenceId: input.evidence.evidenceId,
        offerHash: input.evidence.offerHash,
        offer: input.evidence.offer,
      },
    },
  };
}
