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
  MAXIMUM_JAVASCRIPT_DATE_TIMESTAMP_MS,
  providerSubscriptionReferenceDecoder,
  subscriptionCancellationCommandDecoder,
  subscriptionCancellationIdempotencyKeyDecoder,
  type BillingProvider,
  type ImmediateSubscriptionCancellationResult,
  type PeriodEndSubscriptionCancellationResult,
  type ProviderSubscriptionReference,
  type SubscriptionCancellationCommand,
  type SubscriptionCancellationIdempotencyKey,
} from './public';

type ProviderSubscriptionCancellationCommandBase = {
  readonly provider: BillingProvider;
  readonly providerSubscriptionReference: ProviderSubscriptionReference;
  readonly idempotencyKey: SubscriptionCancellationIdempotencyKey;
  readonly requestedAt: number;
};

export type ProviderSubscriptionCancellationCommand =
  ProviderSubscriptionCancellationCommandBase & {
    readonly effect: 'period-end' | 'immediate';
  };

type ProviderSubscriptionCancellationObservationBase = {
  readonly provider: BillingProvider;
  readonly providerSubscriptionReference: ProviderSubscriptionReference;
  readonly idempotencyKey: SubscriptionCancellationIdempotencyKey;
  readonly observedAt: number;
};

export type ProviderSubscriptionCancellationObservation =
  | (ProviderSubscriptionCancellationObservationBase & {
      readonly kind: 'scheduled';
      readonly accessEndsAt: number;
    })
  | (ProviderSubscriptionCancellationObservationBase & {
      readonly kind: 'cancelled' | 'already-cancelled';
      readonly accessEndsAt: number;
    })
  | (ProviderSubscriptionCancellationObservationBase & {
      readonly kind: 'retryable-failure' | 'terminal-failure';
    });

export type PeriodEndSubscriptionCancellationPlan =
  | {
      readonly kind: 'request-provider';
      readonly command: ProviderSubscriptionCancellationCommand & {
        readonly effect: 'period-end';
      };
    }
  | {
      readonly kind: 'complete';
      readonly result: PeriodEndSubscriptionCancellationResult;
    };

export type ImmediateSubscriptionCancellationPlan =
  | {
      readonly kind: 'request-provider';
      readonly command: ProviderSubscriptionCancellationCommand & {
        readonly effect: 'immediate';
      };
    }
  | {
      readonly kind: 'complete';
      readonly result: ImmediateSubscriptionCancellationResult;
    };

type SharedSubscriptionCancellationResult =
  | {
      readonly kind: 'confirmed';
      readonly outcome: 'already-cancelled';
      readonly confirmedAt: number;
      readonly accessEndsAt: number;
    }
  | Exclude<
      PeriodEndSubscriptionCancellationResult,
      { readonly kind: 'confirmed' }
    >;

const providerObservationDecoder: Decoder<ProviderSubscriptionCancellationObservation> =
  unionDecoder(
    objectDecoder({
      kind: literalDecoder('scheduled'),
      provider: billingProviderDecoder,
      providerSubscriptionReference: providerSubscriptionReferenceDecoder,
      idempotencyKey: subscriptionCancellationIdempotencyKeyDecoder,
      observedAt: safeIntegerDecoder({ minimum: 0 }),
      accessEndsAt: safeIntegerDecoder({
        minimum: 0,
        maximum: MAXIMUM_JAVASCRIPT_DATE_TIMESTAMP_MS,
      }),
    }),
    objectDecoder({
      kind: unionDecoder(
        literalDecoder('cancelled'),
        literalDecoder('already-cancelled'),
      ),
      provider: billingProviderDecoder,
      providerSubscriptionReference: providerSubscriptionReferenceDecoder,
      idempotencyKey: subscriptionCancellationIdempotencyKeyDecoder,
      observedAt: safeIntegerDecoder({ minimum: 0 }),
      accessEndsAt: safeIntegerDecoder({
        minimum: 0,
        maximum: MAXIMUM_JAVASCRIPT_DATE_TIMESTAMP_MS,
      }),
    }),
    objectDecoder({
      kind: unionDecoder(
        literalDecoder('retryable-failure'),
        literalDecoder('terminal-failure'),
      ),
      provider: billingProviderDecoder,
      providerSubscriptionReference: providerSubscriptionReferenceDecoder,
      idempotencyKey: subscriptionCancellationIdempotencyKeyDecoder,
      observedAt: safeIntegerDecoder({ minimum: 0 }),
    }),
  );

export function planPeriodEndSubscriptionCancellation(input: {
  readonly command: SubscriptionCancellationCommand;
  readonly current: BillingSubscriptionRecord | undefined;
}): PeriodEndSubscriptionCancellationPlan {
  const prerequisite = cancellationPrerequisite(input);
  if (prerequisite.kind === 'complete') return prerequisite;
  if (
    input.current?.cancelAt !== null &&
    input.current?.cancelAt !== undefined &&
    input.current.cancelAt <= MAXIMUM_JAVASCRIPT_DATE_TIMESTAMP_MS &&
    input.current.cancelAt >= input.command.requestedAt
  ) {
    return {
      kind: 'complete',
      result: {
        kind: 'confirmed',
        outcome: 'scheduled',
        confirmedAt:
          input.current.cancellationUpdatedAt ?? input.current.updatedAt,
        accessEndsAt: input.current.cancelAt,
      },
    };
  }
  return {
    kind: 'request-provider',
    command: { ...prerequisite.command, effect: 'period-end' },
  };
}

export function planImmediateSubscriptionCancellation(input: {
  readonly command: SubscriptionCancellationCommand;
  readonly current: BillingSubscriptionRecord | undefined;
}): ImmediateSubscriptionCancellationPlan {
  const prerequisite = cancellationPrerequisite(input);
  if (prerequisite.kind === 'complete') return prerequisite;
  return {
    kind: 'request-provider',
    command: { ...prerequisite.command, effect: 'immediate' },
  };
}

function cancellationPrerequisite(input: {
  readonly command: SubscriptionCancellationCommand;
  readonly current: BillingSubscriptionRecord | undefined;
}):
  | {
      readonly kind: 'complete';
      readonly result: SharedSubscriptionCancellationResult;
    }
  | {
      readonly kind: 'request-provider';
      readonly command: ProviderSubscriptionCancellationCommandBase;
    } {
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
    if (
      current.lifecycle.cancelledAt > MAXIMUM_JAVASCRIPT_DATE_TIMESTAMP_MS ||
      current.lifecycle.cancelledAt > input.command.requestedAt
    ) {
      return {
        kind: 'complete',
        result: {
          kind: 'terminal-failure',
          reason: 'invalid-subscription-state',
        },
      };
    }
    return {
      kind: 'complete',
      result: {
        kind: 'confirmed',
        outcome: 'already-cancelled',
        confirmedAt:
          current.cancellationUpdatedAt ?? current.lifecycle.cancelledAt,
        accessEndsAt: current.lifecycle.cancelledAt,
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

export function evaluatePeriodEndProviderSubscriptionCancellation(input: {
  readonly command: ProviderSubscriptionCancellationCommand & {
    readonly effect: 'period-end';
  };
  readonly observation: ProviderSubscriptionCancellationObservation;
}): PeriodEndSubscriptionCancellationResult {
  if (!providerResultMatches(input)) return providerResultMismatch();
  switch (input.observation.kind) {
    case 'scheduled':
      return input.observation.accessEndsAt >= input.observation.observedAt &&
        input.observation.accessEndsAt >= input.command.requestedAt
        ? {
            kind: 'confirmed',
            outcome: 'scheduled',
            confirmedAt: input.observation.observedAt,
            accessEndsAt: input.observation.accessEndsAt,
          }
        : providerResultMismatch();
    case 'already-cancelled':
      return input.observation.accessEndsAt <= input.observation.observedAt
        ? {
            kind: 'confirmed',
            outcome: 'already-cancelled',
            confirmedAt: input.observation.observedAt,
            accessEndsAt: input.observation.accessEndsAt,
          }
        : providerResultMismatch();
    case 'cancelled':
      return providerResultMismatch();
    case 'retryable-failure':
      return { kind: 'retryable-failure', reason: 'provider-unavailable' };
    case 'terminal-failure':
      return { kind: 'terminal-failure', reason: 'provider-terminal' };
  }
}

export function evaluateImmediateProviderSubscriptionCancellation(input: {
  readonly command: ProviderSubscriptionCancellationCommand & {
    readonly effect: 'immediate';
  };
  readonly observation: ProviderSubscriptionCancellationObservation;
}): ImmediateSubscriptionCancellationResult {
  if (!providerResultMatches(input)) return providerResultMismatch();
  switch (input.observation.kind) {
    case 'cancelled':
    case 'already-cancelled':
      return input.observation.accessEndsAt <= input.observation.observedAt
        ? {
            kind: 'confirmed',
            outcome: input.observation.kind,
            confirmedAt: input.observation.observedAt,
            accessEndsAt: input.observation.accessEndsAt,
          }
        : providerResultMismatch();
    case 'scheduled':
      return providerResultMismatch();
    case 'retryable-failure':
      return { kind: 'retryable-failure', reason: 'provider-unavailable' };
    case 'terminal-failure':
      return { kind: 'terminal-failure', reason: 'provider-terminal' };
  }
}

function providerResultMatches(input: {
  readonly command: ProviderSubscriptionCancellationCommand;
  readonly observation: ProviderSubscriptionCancellationObservation;
}): boolean {
  return (
    input.observation.provider === input.command.provider &&
    input.observation.providerSubscriptionReference ===
      input.command.providerSubscriptionReference &&
    input.observation.idempotencyKey === input.command.idempotencyKey
  );
}

function providerResultMismatch(): {
  readonly kind: 'retryable-failure';
  readonly reason: 'provider-result-mismatch';
} {
  return { kind: 'retryable-failure', reason: 'provider-result-mismatch' };
}
