import {
  decodeProviderSubscriptionCancellationObservation,
  evaluateImmediateProviderSubscriptionCancellation,
  evaluatePeriodEndProviderSubscriptionCancellation,
  planImmediateSubscriptionCancellation,
  planPeriodEndSubscriptionCancellation,
} from './cancellation-core';
import type {
  BillingRepository,
  SubscriptionCancellationProviderPort,
} from './ports';
import type {
  ImmediateSubscriptionCancellationResult,
  PeriodEndSubscriptionCancellationResult,
  SubscriptionCancellationPort,
} from './public';

export function createSubscriptionCancellationPort(input: {
  readonly repository: BillingRepository;
  readonly provider: SubscriptionCancellationProviderPort;
}): SubscriptionCancellationPort {
  return {
    async scheduleSubscriptionCancellation(
      command,
    ): Promise<PeriodEndSubscriptionCancellationResult> {
      const current = await input.repository.findByOwner(command);
      const plan = planPeriodEndSubscriptionCancellation({ command, current });
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
        : evaluatePeriodEndProviderSubscriptionCancellation({
            command: plan.command,
            observation,
          });
    },

    async cancelSubscriptionImmediately(
      command,
    ): Promise<ImmediateSubscriptionCancellationResult> {
      const current = await input.repository.findByOwner(command);
      const plan = planImmediateSubscriptionCancellation({ command, current });
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
        : evaluateImmediateProviderSubscriptionCancellation({
            command: plan.command,
            observation,
          });
    },
  };
}
