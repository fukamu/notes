import { describe, expect, it } from 'vitest';
import {
  decodeProviderSubscriptionCancellationObservation,
  evaluateProviderSubscriptionCancellation,
  planSubscriptionCancellation,
  type ProviderSubscriptionCancellationCommand,
} from '@/server/billing/cancellation-core';
import {
  planCheckoutCreation,
  planVerifiedProviderFact,
  type BillingSubscriptionRecord,
} from '@/server/billing/core';
import {
  parseSubscriptionCancellationIdempotencyKey,
  subscriptionCancellationCommandDecoder,
  subscriptionCancellationResultDecoder,
  type SubscriptionCancellationCommand,
} from '@/server/billing/public';
import {
  beginCheckoutCommand,
  billingContext,
  billingIds,
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
  it('decodes only bounded provider-neutral commands and results', () => {
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
      subscriptionCancellationResultDecoder.decode({
        kind: 'confirmed',
        outcome: 'cancelled',
        confirmedAt: 10_000,
      }).ok,
    ).toBe(true);
    expect(
      subscriptionCancellationResultDecoder.decode({
        kind: 'confirmed',
        outcome: 'scheduled',
      }).ok,
    ).toBe(false);
    expect(() =>
      parseSubscriptionCancellationIdempotencyKey('contains secret space'),
    ).toThrow();
  });

  it('plans mapped trialing, active, and delinquent subscriptions without exposing provider references publicly', () => {
    for (const current of [
      trialingRecord(),
      activeRecord(),
      delinquentRecord(),
    ]) {
      const plan = planSubscriptionCancellation({
        command: command(),
        current,
      });
      expect(plan).toMatchObject({
        kind: 'request-provider',
        command: {
          provider: current.provider,
          providerSubscriptionReference: current.providerSubscriptionReference,
          idempotencyKey,
          requestedAt: 10_000,
        },
      });
    }
  });

  it('treats a local cancelled fact as idempotent and rejects unsafe ownership or mapping states', () => {
    expect(
      planSubscriptionCancellation({
        command: command(),
        current: cancelledRecord(),
      }),
    ).toEqual({
      kind: 'complete',
      result: {
        kind: 'confirmed',
        outcome: 'already-cancelled',
        confirmedAt: 9_000,
      },
    });
    expect(
      planSubscriptionCancellation({ command: command(), current: undefined }),
    ).toMatchObject({
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'subscription-not-found' },
    });
    expect(
      planSubscriptionCancellation({
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
      planSubscriptionCancellation({
        command: command(),
        current: checkoutRecord(),
      }),
    ).toMatchObject({
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'provider-not-linked' },
    });
    expect(
      planSubscriptionCancellation({
        command: { ...command(), requestedAt: Number.NaN },
        current: trialingRecord(),
      }),
    ).toMatchObject({
      kind: 'complete',
      result: { kind: 'terminal-failure', reason: 'invalid-command' },
    });
  });

  it('confirms only a matching immediate provider observation', () => {
    const providerCommand = requiredProviderCommand(trialingRecord());
    const base = observation(providerCommand, 'cancelled');
    expect(
      evaluateProviderSubscriptionCancellation({
        command: providerCommand,
        observation: base,
      }),
    ).toEqual({
      kind: 'confirmed',
      outcome: 'cancelled',
      confirmedAt: 10_000,
    });
    expect(
      evaluateProviderSubscriptionCancellation({
        command: providerCommand,
        observation: { ...base, kind: 'already-cancelled' },
      }),
    ).toMatchObject({ kind: 'confirmed', outcome: 'already-cancelled' });
    expect(
      evaluateProviderSubscriptionCancellation({
        command: providerCommand,
        observation: { ...base, kind: 'retryable-failure' },
      }),
    ).toEqual({ kind: 'retryable-failure', reason: 'provider-unavailable' });
    expect(
      evaluateProviderSubscriptionCancellation({
        command: providerCommand,
        observation: { ...base, kind: 'terminal-failure' },
      }),
    ).toEqual({ kind: 'terminal-failure', reason: 'provider-terminal' });
  });

  it('rejects malformed, mismatched, and out-of-order provider observations', () => {
    const providerCommand = requiredProviderCommand(trialingRecord());
    const base = observation(providerCommand, 'cancelled');
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
    ]) {
      expect(
        evaluateProviderSubscriptionCancellation({
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

function cancelledRecord(): BillingSubscriptionRecord {
  return apply(trialingRecord(), subscriptionCancelledFact(9_000));
}

function requiredProviderCommand(
  current: BillingSubscriptionRecord,
): ProviderSubscriptionCancellationCommand {
  const plan = planSubscriptionCancellation({ command: command(), current });
  if (plan.kind !== 'request-provider') {
    throw new Error('provider command fixture missing');
  }
  return plan.command;
}

function observation(
  providerCommand: ProviderSubscriptionCancellationCommand,
  kind:
    | 'cancelled'
    | 'already-cancelled'
    | 'retryable-failure'
    | 'terminal-failure',
) {
  return {
    kind,
    provider: providerCommand.provider,
    providerSubscriptionReference:
      providerCommand.providerSubscriptionReference,
    idempotencyKey: providerCommand.idempotencyKey,
    observedAt: providerCommand.requestedAt,
  } as const;
}
