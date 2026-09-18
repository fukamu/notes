import { describe, expect, it } from 'vitest';
import {
  parseBillingSubscriptionId,
  parseCheckoutIntentId,
} from '@/server/billing/public';
import { createFakeBillingModule } from '@/server/billing/fake';
import { createContractCheckoutApplication } from '@/server/legal-checkout/checkout-service';
import { createFakeContractEvidenceRepository } from '@/server/legal-checkout/fake';
import { createContractEvidenceService } from '@/server/legal-checkout/service';
import {
  createFakeStripeTransport,
  createFakeStripeWebhookVerifier,
} from '@/server/stripe/fake';
import { createStripeBillingAdapter } from '@/server/stripe/service';
import { billingContext } from '@/tests/fixtures/billing';
import {
  contractCommand,
  contractDisclosure,
  contractIds,
} from '@/tests/fixtures/legal-checkout';
import { termsConsentIds } from '@/tests/fixtures/terms-consent';
import {
  stripeCheckoutMetadata,
  stripeCheckoutResponse,
  stripeConfiguration,
} from '@/tests/fixtures/stripe';

describe('contract evidence to Stripe Checkout integration', () => {
  it('survives provider response loss and reuses the evidence-bound Checkout session', async () => {
    const setup = integrationSetup({ loseFirstCheckoutResponse: true });
    const first = await setup.application.confirm(confirmInput());
    expect(first).toEqual({
      kind: 'rejected',
      reason: 'provider-unavailable',
    });
    await expect(
      setup.application.confirm({
        ...confirmInput(),
        evidenceId: contractIds.evidenceB,
      }),
    ).resolves.toMatchObject({
      kind: 'redirect',
      evidenceOutcome: 'replayed',
      evidence: { evidenceId: contractIds.evidenceA },
    });

    const commands = setup.transport.checkoutCommands();
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
    expect(commands[0]).toMatchObject({
      idempotencyKey: parseCheckoutIntentId(contractIds.submissionA),
    });
    expect(new Map(commands[0]?.fields).get('submit_type')).toBe('subscribe');
    expect(setup.billing.repository.inspect().subscriptions).toHaveLength(1);
  });

  it('rejects altered contract metadata returned by the provider', async () => {
    const setup = integrationSetup({
      metadata: stripeCheckoutMetadata({
        billing_subscription_id: parseBillingSubscriptionId(
          contractIds.evidenceA,
        ),
        checkout_intent_id: parseCheckoutIntentId(contractIds.submissionA),
        contract_offer_hash: contractIds.offerHashB,
      }),
    });
    await expect(setup.application.confirm(confirmInput())).resolves.toEqual({
      kind: 'rejected',
      reason: 'provider-mapping-mismatch',
    });
    expect(setup.billing.repository.inspect().checkoutIntents[0]).toMatchObject(
      { status: 'created', providerCheckoutReference: null },
    );
  });
});

function integrationSetup(
  options: {
    readonly loseFirstCheckoutResponse?: boolean;
    readonly metadata?: Readonly<Record<string, unknown>>;
  } = {},
) {
  const subscriptionId = parseBillingSubscriptionId(contractIds.evidenceA);
  const checkoutIntentId = parseCheckoutIntentId(contractIds.submissionA);
  const billing = createFakeBillingModule([billingContext()]);
  const transport = createFakeStripeTransport({
    checkoutResponse: stripeCheckoutResponse({
      client_reference_id: checkoutIntentId,
      metadata:
        options.metadata ??
        stripeCheckoutMetadata({
          billing_subscription_id: subscriptionId,
          checkout_intent_id: checkoutIntentId,
        }),
    }),
    snapshots: new Map(),
    ...(options.loseFirstCheckoutResponse === undefined
      ? {}
      : { loseFirstCheckoutResponse: options.loseFirstCheckoutResponse }),
  });
  const stripe = createStripeBillingAdapter({
    configuration: stripeConfiguration,
    billing: billing.api,
    transport,
    webhookVerifier: createFakeStripeWebhookVerifier(),
  });
  const evidence = createContractEvidenceService({
    repository: createFakeContractEvidenceRepository(),
    hasher: { hash: async () => contractIds.offerHashA },
  });
  return {
    application: createContractCheckoutApplication({
      evidence,
      offerSource: { readCurrent: () => contractDisclosure() },
      terms: {
        verify: async () => ({
          kind: 'accepted',
          consentId: termsConsentIds.consentA,
        }),
      },
      provider: stripe,
    }),
    billing,
    transport,
  };
}

function confirmInput() {
  return {
    context: billingContext(),
    command: contractCommand(),
    evidenceId: contractIds.evidenceA,
    confirmedAt: 1_000,
  } as const;
}
