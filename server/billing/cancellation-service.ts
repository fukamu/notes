import {
  decodeProviderSubscriptionCancellationObservation,
  evaluateProviderSubscriptionCancellation,
  planSubscriptionCancellation,
} from './cancellation-core';
import type {
  BillingRepository,
  SubscriptionCancellationProviderPort,
} from './ports';
import type {
  SubscriptionCancellationPort,
  SubscriptionCancellationResult,
} from './public';

export function createSubscriptionCancellationPort(input: {
  readonly repository: BillingRepository;
  readonly provider: SubscriptionCancellationProviderPort;
}): SubscriptionCancellationPort {
  return {
    async cancelSubscription(command): Promise<SubscriptionCancellationResult> {
      const current = await input.repository.findByOwner(command);
      const plan = planSubscriptionCancellation({ command, current });
      if (plan.kind === 'complete') return plan.result;

      let rawObservation: unknown;
      try {
        rawObservation = await input.provider.cancelSubscription(plan.command);
      } catch {
        return { kind: 'retryable-failure', reason: 'provider-unavailable' };
      }
      const observation =
        decodeProviderSubscriptionCancellationObservation(rawObservation);
      return observation === undefined
        ? {
            kind: 'retryable-failure',
            reason: 'malformed-provider-response',
          }
        : evaluateProviderSubscriptionCancellation({
            command: plan.command,
            observation,
          });
    },
  };
}
