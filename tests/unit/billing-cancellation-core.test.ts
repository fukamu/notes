import { describe, expect, it } from 'vitest';
import {
  decodeProviderSubscriptionCancellationObservation,
  evaluateImmediateProviderSubscriptionCancellation,
  evaluatePeriodEndProviderSubscriptionCancellation,
  planImmediateSubscriptionCancellation,
  planPeriodEndSubscriptionCancellation,
  type ProviderSubscriptionCancellationCommand,
} from '@/server/billing/cancellation-core';
import {
  planCheckoutCreation,
  planVerifiedProviderFact,
  type BillingSubscriptionRecord,
} from '@/server/billing/core';
import {
  immediateSubscriptionCancellationResultDecoder,
  MAXIMUM_JAVASCRIPT_DATE_TIMESTAMP_MS,
  parseSubscriptionCancellationIdempotencyKey,
  periodEndSubscriptionCancellationResultDecoder,
  subscriptionCancellationCommandDecoder,
  type SubscriptionCancellationCommand,
} from '@/server/billing/public';
import {
  beginCheckoutCommand,
  billingContext,
  billingIds,
  cancellationScheduledFact,
  invoicePaidFact,
  paymentFailedFact,
  subscriptionCancelledFact,
  trialStartedFact,
} from '@/tests/fixtures/billing';

const idempotencyKey = parseSubscriptionCancellationIdempotencyKey(
  '01991f20-61d2-7000-8000-000000000801',
);
const otherIdempotencyKey = parseSubscriptionCancellationIdempotencyKey(
  '01991f20-61d2-7000-8000-000000000802',
);

describe('subscription cancellation core', () => {
  it('decodes bounded commands and keeps period-end and immediate results distinct', () => {
    expect(subscriptionCancellationCommandDecoder.decode(command()).ok).toBe(
      true,
    );
    expect(
      subscriptionCancellationCommandDecoder.decode({
        ...command(),
        requestedAt: -1,
      }).ok,
    ).toBe(false);
    expect(
      periodEndSubscriptionCancellationResultDecoder.decode({
        kind: 'confirmed',
        outcome: 'scheduled',
        confirmedAt: 10_000,
        accessEndsAt: 20_000,
      }).ok,
    ).toBe(true);
    expect(
      periodEndSubscriptionCancellationResultDecoder.decode({
        kind: 'confirmed',
        outcome: 'cancelled',
        confirmedAt: 10_000,
        accessEndsAt: 10_000,
      }).ok,
    ).toBe(false);
    expect(
      immediateSubscriptionCancellationResultDecoder.decode({
        kind: 'confirmed',
        outcome: 'cancelled',
        confirmedAt: 10_000,
        accessEndsAt: 10_000,
      }).ok,
    ).toBe(true);
    expect(() =>
      parseSubscriptionCancellationIdempotencyKey('contains secret space'),
    ).toThrow();
  });

  it('plans explicit period-end and immediate provider effects for live subscriptions', () => {
    for (const current of [
      trialingRecord(),
      activeRecord(),
      delinquentRecord(),
    ]) {
      expect(
        planPeriodEndSubscriptionCancellation({
          command: command(),
          current,
        }),
      ).toMatchObject({
        kind: 'request-provider',
        command: {
          effect: 'period-end',
          provider: current.provider,
          providerSubscriptionReference: current.providerSubscriptionReference,
          idempotencyKey,
          requestedAt: 10_000,
        },
      });
      expect(
        planImmediateSubscriptionCancellation({
          command: command(),
          current,
        }),
      ).toMatchObject({
        kind: 'request-provider',
        command: { effect: 'immediate' },
      });
    }
  });

  it('reuses a verified period-end date but still requires an immediate effect for deletion', () => {
    const current = scheduledRecord();
    expect(
      planPeriodEndSubscriptionCancellation({ command: command(), current }),
    ).toEqual({
      kind: 'complete',
      result: {
        kind: 'confirmed',
        outcome: 'scheduled',
        confirmedAt: cancellationScheduledFact().occurredAt,
        accessEndsAt: cancellationScheduledFact().cancelAt,
      },
    });
    expect(
      planImmediateSubscriptionCancellation({ command: command(), current }),
    ).toMatchObject({
      kind: 'request-provider',
      command: { effect: 'immediate' },
    });
  });

  it('treats a cancelled aggregate as idempotent and rejects unsafe ownership or mapping states', () => {
    for (const plan of [
      planPeriodEndSubscriptionCancellation({
        command: command(),
        current: cancelledRecord(),
      }),
      planImmediateSubscriptionCancellation({
        command: command(),
        current: cancelledRecord(),
      }),
    ]) {
      expect(plan).toEqual({
        kind: 'complete',
        result: {
          kind: 'confirmed',
          outcome: 'already-cancelled',
          confirmedAt: 9_000,
          accessEndsAt: 9_000,
        },
      });
    }
    expect(
      planPeriodEndSubscriptionCancellation({
        command: command(),
        current: {
          ...cancelledRecord(),
          lifecycle: {
            kind: 'cancelled',
            cancelledAt: command().requestedAt + 1,
          },
        },
      }),
    ).toMatchObject({
      kind: 'complete',
      result: {
        kind: 'terminal-failure',
        reason: 'invalid-subscription-state',
      },
    });
    expect(
      planImmediateSubscriptionCancellation({
        command: {
          ...command(),
          requestedAt: MAXIMUM_JAVASCRIPT_DATE_TIMESTAMP_MS,
        },
        current: {
          ...cancelledRecord(),
          lifecycle: {
            kind: 'cancelled',
            cancelledAt: MAXIMUM_JAVASCRIPT_DATE_TIMESTAMP_MS + 1,
          },
        },
      }),
    ).toMatchObject({
      kind: 'complete',
      result: {
        kind: 'terminal-failure',
        reason: 'invalid-subscription-state',
      },
    });
    expect(
      planPeriodEndSubscriptionCancellation({
        command: command(),
        current: undefined,
      }),
    ).toMatchObject({
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'subscription-not-found' },
    });
    expect(
      planPeriodEndSubscriptionCancellation({
        command: {
          ...command(),
          accountId: billingContext('b').accountId,
          vaultId: billingContext('b').vaultId,
        },
        current: trialingRecord(),
      }),
    ).toMatchObject({
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'owner-mismatch' },
    });
    expect(
      planPeriodEndSubscriptionCancellation({
        command: command(),
        current: checkoutRecord(),
      }),
    ).toMatchObject({
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'provider-not-linked' },
    });
    expect(
      planPeriodEndSubscriptionCancellation({
        command: { ...command(), requestedAt: Number.NaN },
        current: trialingRecord(),
      }),
    ).toMatchObject({
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'invalid-command' },
    });
  });

  it('confirms a matching period-end schedule and rejects immediate cancellation for that request', () => {
    const providerCommand = requiredProviderCommand('period-end');
    const scheduled = {
      ...observationBase(providerCommand),
      kind: 'scheduled' as const,
      accessEndsAt: 20_000,
    };
    expect(
      evaluatePeriodEndProviderSubscriptionCancellation({
        command: providerCommand,
        observation: scheduled,
      }),
    ).toEqual({
      kind: 'confirmed',
      outcome: 'scheduled',
      confirmedAt: 10_000,
      accessEndsAt: 20_000,
    });
    expect(
      evaluatePeriodEndProviderSubscriptionCancellation({
        command: providerCommand,
        observation: {
          ...observationBase(providerCommand),
          kind: 'cancelled',
          accessEndsAt: 10_000,
        },
      }),
    ).toEqual({
      kind: 'retryable-failure',
      reason: 'provider-result-mismatch',
    });
    expect(
      evaluatePeriodEndProviderSubscriptionCancellation({
        command: { ...providerCommand, requestedAt: 30_000 },
        observation: scheduled,
      }),
    ).toEqual({
      kind: 'retryable-failure',
      reason: 'provider-result-mismatch',
    });
  });

  it('confirms only an immediate effect for account deletion', () => {
    const providerCommand = requiredProviderCommand('immediate');
    const cancelled = {
      ...observationBase(providerCommand),
      kind: 'cancelled' as const,
      accessEndsAt: 10_000,
    };
    expect(
      evaluateImmediateProviderSubscriptionCancellation({
        command: providerCommand,
        observation: cancelled,
      }),
    ).toEqual({
      kind: 'confirmed',
      outcome: 'cancelled',
      confirmedAt: 10_000,
      accessEndsAt: 10_000,
    });
    expect(
      evaluateImmediateProviderSubscriptionCancellation({
        command: providerCommand,
        observation: {
          ...observationBase(providerCommand),
          kind: 'scheduled',
          accessEndsAt: 20_000,
        },
      }),
    ).toEqual({
      kind: 'retryable-failure',
      reason: 'provider-result-mismatch',
    });
  });

  it('rejects malformed, mismatched, and out-of-order provider observations', () => {
    const providerCommand = requiredProviderCommand('immediate');
    const base = {
      ...observationBase(providerCommand),
      kind: 'cancelled' as const,
      accessEndsAt: 10_000,
    };
    expect(
      decodeProviderSubscriptionCancellationObservation({ kind: 'cancelled' }),
    ).toBeUndefined();
    expect(decodeProviderSubscriptionCancellationObservation(base)).toEqual(
      base,
    );
    for (const candidate of [
      { ...base, idempotencyKey: otherIdempotencyKey },
      { ...base, observedAt: providerCommand.requestedAt - 1 },
      {
        ...base,
        providerSubscriptionReference: billingIds.providerSubscriptionB,
      },
      { ...base, accessEndsAt: providerCommand.requestedAt + 1 },
    ]) {
      expect(
        evaluateImmediateProviderSubscriptionCancellation({
          command: providerCommand,
          observation: candidate,
        }),
      ).toEqual({
        kind: 'retryable-failure',
        reason: 'provider-result-mismatch',
      });
    }
  });
});

function command(): SubscriptionCancellationCommand {
  return {
    accountId: billingContext().accountId,
    vaultId: billingContext().vaultId,
    idempotencyKey,
    requestedAt: 10_000,
  };
}

function checkoutRecord(): BillingSubscriptionRecord {
  const plan = planCheckoutCreation(billingContext(), beginCheckoutCommand());
  if (plan.kind !== 'create') throw new Error('invalid checkout fixture');
  return plan.record;
}

function apply(
  current: BillingSubscriptionRecord,
  fact: Parameters<typeof planVerifiedProviderFact>[1],
): BillingSubscriptionRecord {
  const plan = planVerifiedProviderFact(current, fact);
  if (plan.kind !== 'apply') throw new Error('invalid billing fact fixture');
  return plan.record;
}

function trialingRecord(): BillingSubscriptionRecord {
  return apply(checkoutRecord(), trialStartedFact());
}

function activeRecord(): BillingSubscriptionRecord {
  return apply(trialingRecord(), invoicePaidFact(7_000));
}

function delinquentRecord(): BillingSubscriptionRecord {
  return apply(trialingRecord(), paymentFailedFact(8_000));
}

function scheduledRecord(): BillingSubscriptionRecord {
  return apply(trialingRecord(), cancellationScheduledFact());
}

function cancelledRecord(): BillingSubscriptionRecord {
  return apply(trialingRecord(), subscriptionCancelledFact(9_000));
}

function requiredProviderCommand(
  effect: 'period-end',
): ProviderSubscriptionCancellationCommand & { readonly effect: 'period-end' };
function requiredProviderCommand(
  effect: 'immediate',
): ProviderSubscriptionCancellationCommand & { readonly effect: 'immediate' };
function requiredProviderCommand(
  effect: 'period-end' | 'immediate',
): ProviderSubscriptionCancellationCommand {
  const plan =
    effect === 'period-end'
      ? planPeriodEndSubscriptionCancellation({
          command: command(),
          current: trialingRecord(),
        })
      : planImmediateSubscriptionCancellation({
          command: command(),
          current: trialingRecord(),
        });
  if (plan.kind !== 'request-provider') {
    throw new Error('provider command fixture missing');
  }
  return plan.command;
}

function observationBase(command: ProviderSubscriptionCancellationCommand) {
  return {
    provider: command.provider,
    providerSubscriptionReference: command.providerSubscriptionReference,
    idempotencyKey: command.idempotencyKey,
    observedAt: command.requestedAt,
  } as const;
}
