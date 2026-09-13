import {
  literalDecoder,
  objectDecoder,
  safeIntegerDecoder,
  unionDecoder,
  type Decoder,
} from '../../lib/codec/core';
import type { BillingSubscriptionRecord } from './core';
import {
  billingProviderDecoder,
  providerSubscriptionReferenceDecoder,
  subscriptionCancellationCommandDecoder,
  subscriptionCancellationIdempotencyKeyDecoder,
  type BillingProvider,
  type ProviderSubscriptionReference,
  type SubscriptionCancellationCommand,
  type SubscriptionCancellationIdempotencyKey,
  type SubscriptionCancellationResult,
} from './public';

export type ProviderSubscriptionCancellationCommand = {
  readonly provider: BillingProvider;
  readonly providerSubscriptionReference: ProviderSubscriptionReference;
  readonly idempotencyKey: SubscriptionCancellationIdempotencyKey;
  readonly requestedAt: number;
};

export type ProviderSubscriptionCancellationObservation = {
  readonly kind:
    | 'cancelled'
    | 'already-cancelled'
    | 'retryable-failure'
    | 'terminal-failure';
  readonly provider: BillingProvider;
  readonly providerSubscriptionReference: ProviderSubscriptionReference;
  readonly idempotencyKey: SubscriptionCancellationIdempotencyKey;
  readonly observedAt: number;
};

export type SubscriptionCancellationPlan =
  | {
      readonly kind: 'request-provider';
      readonly command: ProviderSubscriptionCancellationCommand;
    }
  | {
      readonly kind: 'complete';
      readonly result: SubscriptionCancellationResult;
    };

const providerObservationDecoder: Decoder<ProviderSubscriptionCancellationObservation> =
  objectDecoder({
    kind: unionDecoder(
      literalDecoder('cancelled'),
      literalDecoder('already-cancelled'),
      literalDecoder('retryable-failure'),
      literalDecoder('terminal-failure'),
    ),
    provider: billingProviderDecoder,
    providerSubscriptionReference: providerSubscriptionReferenceDecoder,
    idempotencyKey: subscriptionCancellationIdempotencyKeyDecoder,
    observedAt: safeIntegerDecoder({ minimum: 0 }),
  });

export function planSubscriptionCancellation(input: {
  readonly command: SubscriptionCancellationCommand;
  readonly current: BillingSubscriptionRecord | undefined;
}): SubscriptionCancellationPlan {
  if (!subscriptionCancellationCommandDecoder.decode(input.command).ok) {
    return {
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'invalid-command' },
    };
  }
  const current = input.current;
  if (current === undefined) {
    return {
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'subscription-not-found' },
    };
  }
  if (
    current.accountId !== input.command.accountId ||
    current.vaultId !== input.command.vaultId
  ) {
    return {
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'owner-mismatch' },
    };
  }
  if (current.lifecycle.kind === 'cancelled') {
    return {
      kind: 'complete',
      result: {
        kind: 'confirmed',
        outcome: 'already-cancelled',
        confirmedAt: current.lifecycle.cancelledAt,
      },
    };
  }
  if (current.providerSubscriptionReference === null) {
    return {
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'provider-not-linked' },
    };
  }
  return {
    kind: 'request-provider',
    command: {
      provider: current.provider,
      providerSubscriptionReference: current.providerSubscriptionReference,
      idempotencyKey: input.command.idempotencyKey,
      requestedAt: input.command.requestedAt,
    },
  };
}

export function decodeProviderSubscriptionCancellationObservation(
  input: unknown,
): ProviderSubscriptionCancellationObservation | undefined {
  const decoded = providerObservationDecoder.decode(input);
  return decoded.ok ? decoded.value : undefined;
}

export function evaluateProviderSubscriptionCancellation(input: {
  readonly command: ProviderSubscriptionCancellationCommand;
  readonly observation: ProviderSubscriptionCancellationObservation;
}): SubscriptionCancellationResult {
  if (
    input.observation.provider !== input.command.provider ||
    input.observation.providerSubscriptionReference !==
      input.command.providerSubscriptionReference ||
    input.observation.idempotencyKey !== input.command.idempotencyKey ||
    input.observation.observedAt < input.command.requestedAt
  ) {
    return { kind: 'retryable-failure', reason: 'provider-result-mismatch' };
  }
  switch (input.observation.kind) {
    case 'cancelled':
    case 'already-cancelled':
      return {
        kind: 'confirmed',
        outcome: input.observation.kind,
        confirmedAt: input.observation.observedAt,
      };
    case 'retryable-failure':
      return { kind: 'retryable-failure', reason: 'provider-unavailable' };
    case 'terminal-failure':
      return { kind: 'terminal-failure', reason: 'provider-terminal' };
  }
}
