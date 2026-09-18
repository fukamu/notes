import { describe, expect, it, vi } from 'vitest';
import { parseProviderCheckoutReference } from '@/server/billing/public';
import { planContractHostedCheckout } from '@/server/legal-checkout/checkout-core';
import { createContractCheckoutApplication } from '@/server/legal-checkout/checkout-service';
import { createContractEvidenceService } from '@/server/legal-checkout/service';
import { createFakeContractEvidenceRepository } from '@/server/legal-checkout/fake';
import type { StripeBillingAdapter } from '@/server/stripe/public';
import { billingContext } from '@/tests/fixtures/billing';
import {
  contractCommand,
  contractDisclosure,
  contractEvidence,
  contractIds,
} from '@/tests/fixtures/legal-checkout';
import { termsConsentIds } from '@/tests/fixtures/terms-consent';

describe('contract checkout orchestration', () => {
  it('derives stable Billing and Checkout identifiers from immutable evidence', () => {
    expect(
      planContractHostedCheckout({
        evidence: contractEvidence(),
        createdAt: 1_000,
      }),
    ).toMatchObject({
      kind: 'ready',
      command: {
        subscriptionId: contractIds.evidenceA,
        checkoutIntentId: contractIds.submissionA,
        createdAt: 1_000,
        contract: {
          evidenceId: contractIds.evidenceA,
          offerHash: contractIds.offerHashA,
        },
      },
    });
    expect(
      planContractHostedCheckout({
        evidence: contractEvidence(),
        createdAt: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toEqual({ kind: 'rejected', reason: 'invalid-command' });
  });

  it('prepares the authoritative offer and starts the provider only after evidence is recorded', async () => {
    const beginHostedCheckout = vi.fn(async () => ({
      kind: 'redirect' as const,
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_FukamuA',
      providerCheckoutReference:
        parseProviderCheckoutReference('checkout-reference'),
    }));
    const application = setupApplication(beginHostedCheckout);
    const prepared = await application.prepareOffer();
    expect(prepared).toMatchObject({
      kind: 'available',
      prepared: { offerHash: contractIds.offerHashA },
    });

    await expect(
      application.confirm({
        context: billingContext(),
        command: contractCommand(),
        evidenceId: contractIds.evidenceA,
        confirmedAt: 1_000,
      }),
    ).resolves.toMatchObject({
      kind: 'redirect',
      evidenceOutcome: 'recorded',
      evidence: { evidenceId: contractIds.evidenceA },
    });
    const providerPlan = planContractHostedCheckout({
      evidence: contractEvidence(),
      createdAt: 1_000,
    });
    if (providerPlan.kind !== 'ready') throw new Error('expected ready plan');
    expect(beginHostedCheckout).toHaveBeenCalledWith(
      billingContext(),
      providerPlan.command,
    );
  });

  it('retries provider response loss with the original evidence and idempotency mapping', async () => {
    let calls = 0;
    const commands: unknown[] = [];
    const beginHostedCheckout = vi.fn(async (_context, command) => {
      commands.push(command);
      calls += 1;
      if (calls === 1) throw new Error('simulated provider response loss');
      return {
        kind: 'redirect' as const,
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_FukamuA',
        providerCheckoutReference:
          parseProviderCheckoutReference('checkout-reference'),
      };
    });
    const application = setupApplication(beginHostedCheckout);
    const input = {
      context: billingContext(),
      command: contractCommand(),
      evidenceId: contractIds.evidenceA,
      confirmedAt: 1_000,
    } as const;
    await expect(application.confirm(input)).resolves.toEqual({
      kind: 'rejected',
      reason: 'provider-unavailable',
    });
    await expect(
      application.confirm({ ...input, evidenceId: contractIds.evidenceB }),
    ).resolves.toMatchObject({
      kind: 'redirect',
      evidenceOutcome: 'replayed',
      evidence: { evidenceId: contractIds.evidenceA },
    });
    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual(commands[0]);
  });

  it('rejects missing consent and stale offers before the provider boundary', async () => {
    const beginHostedCheckout = vi.fn();
    const application = setupApplication(beginHostedCheckout);
    await expect(
      application.confirm({
        context: billingContext(),
        command: contractCommand({ consent: { kind: 'not-affirmed' } }),
        evidenceId: contractIds.evidenceA,
        confirmedAt: 1_000,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'consent-required' });
    await expect(
      application.confirm({
        context: billingContext(),
        command: contractCommand({
          presentedOfferHash: contractIds.offerHashB,
        }),
        evidenceId: contractIds.evidenceA,
        confirmedAt: 1_000,
      }),
    ).resolves.toEqual({ kind: 'rejected', reason: 'stale-offer' });
    expect(beginHostedCheckout).not.toHaveBeenCalled();
  });

  it('fails closed when the offer source, evidence dependency, or provider is unavailable', async () => {
    const sourceFailure = setupApplication(vi.fn(), {
      readCurrent() {
        throw new Error('unavailable');
      },
    });
    await expect(sourceFailure.prepareOffer()).resolves.toEqual({
      kind: 'unavailable',
      reason: 'invalid-offer',
    });

    const evidence = createContractEvidenceService({
      repository: createFakeContractEvidenceRepository(),
      hasher: { hash: async () => contractIds.offerHashA },
    });
    const application = createContractCheckoutApplication({
      evidence,
      offerSource: { readCurrent: () => contractDisclosure() },
      terms: acceptedTerms(),
      provider: {
        beginHostedCheckout: async () => ({
          kind: 'rejected',
          reason: 'malformed-provider-response',
        }),
      },
    });
    await expect(
      application.confirm({
        context: billingContext(),
        command: contractCommand(),
        evidenceId: contractIds.evidenceA,
        confirmedAt: 1_000,
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'malformed-provider-response',
    });
  });

  it('requires current terms evidence with the same submission before commercial evidence or provider calls', async () => {
    const beginHostedCheckout = vi.fn();
    const confirm = vi.fn();
    const baseEvidence = createContractEvidenceService({
      repository: createFakeContractEvidenceRepository(),
      hasher: { hash: async () => contractIds.offerHashA },
    });
    const application = createContractCheckoutApplication({
      evidence: {
        prepareOffer: (input) => baseEvidence.prepareOffer(input),
        confirm,
      },
      offerSource: { readCurrent: () => contractDisclosure() },
      terms: {
        verify: async () => ({
          kind: 'rejected',
          reason: 'terms-consent-required',
        }),
      },
      provider: { beginHostedCheckout },
    });

    await expect(
      application.confirm({
        context: billingContext(),
        command: contractCommand(),
        evidenceId: contractIds.evidenceA,
        confirmedAt: 1_000,
      }),
    ).resolves.toEqual({
      kind: 'rejected',
      reason: 'terms-consent-required',
    });
    expect(confirm).not.toHaveBeenCalled();
    expect(beginHostedCheckout).not.toHaveBeenCalled();
  });
});

function setupApplication(
  beginHostedCheckout: StripeBillingAdapter['beginHostedCheckout'],
  offerSource = { readCurrent: () => contractDisclosure() },
) {
  return createContractCheckoutApplication({
    evidence: createContractEvidenceService({
      repository: createFakeContractEvidenceRepository(),
      hasher: { hash: async () => contractIds.offerHashA },
    }),
    offerSource,
    terms: acceptedTerms(),
    provider: { beginHostedCheckout },
  });
}

function acceptedTerms() {
  return {
    verify: async () => ({
      kind: 'accepted' as const,
      consentId: termsConsentIds.consentA,
    }),
  };
}
