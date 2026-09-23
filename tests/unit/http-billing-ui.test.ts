import { describe, expect, it } from 'vitest';
import type { BillingCheckoutReview } from '@/lib/application/billing-ui';
import {
  createBillingCancellationIdempotencyKey,
  createBillingCheckoutSubmissionId,
  createBillingUiHttpTransport,
} from '@/lib/client/http-billing-ui';
import { planContractOffer } from '@/server/legal-checkout/core';
import {
  contractDisclosure,
  contractIds,
} from '@/tests/fixtures/legal-checkout';

describe('billing UI HTTP adapter', () => {
  it('decodes the authoritative offer and sends only consent correlation fields', async () => {
    const offer = contractOffer();
    const calls: { readonly input: string; readonly init: RequestInit }[] = [];
    const transport = createBillingUiHttpTransport(async (input, init = {}) => {
      calls.push({ input: requestLabel(input), init });
      if (init.method === 'GET') {
        return Response.json({
          offer,
          offerHash: contractIds.offerHashA,
        });
      }
      return Response.json({
        kind: 'redirect',
        evidenceOutcome: 'recorded',
        evidenceId: contractIds.evidenceA,
        offerHash: contractIds.offerHashA,
        offerVersion: offer.offerVersion,
        checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_fukamu',
      });
    });

    await expect(transport.loadOffer()).resolves.toMatchObject({
      kind: 'available',
      offer: { trialDays: 14, firstChargeDay: 15 },
    });
    await expect(transport.submitCheckout(review())).resolves.toEqual({
      kind: 'provider-ready',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_fukamu',
      evidenceOutcome: 'recorded',
    });
    const requestBody = calls[1]?.init.body;
    if (typeof requestBody !== 'string') {
      throw new Error('expected a JSON request body');
    }
    expect(JSON.parse(requestBody)).toEqual({
      submissionId: contractIds.submissionA,
      presentedOfferHash: contractIds.offerHashA,
      consent: { kind: 'affirmed' },
    });
    expect(calls[1]?.init.credentials).toBe('same-origin');
    expect(calls[1]?.init.cache).toBe('no-store');
  });

  it('rejects malformed or untrusted success data and distinguishes a stale offer', async () => {
    const untrusted = createBillingUiHttpTransport(async () =>
      Response.json({
        kind: 'redirect',
        evidenceOutcome: 'recorded',
        evidenceId: contractIds.evidenceA,
        offerHash: contractIds.offerHashA,
        offerVersion: contractOffer().offerVersion,
        checkoutUrl: 'https://attacker.example/checkout',
      }),
    );
    await expect(untrusted.submitCheckout(review())).resolves.toEqual({
      kind: 'unavailable',
    });

    const stale = createBillingUiHttpTransport(async () =>
      Response.json({ error: 'offer-changed' }, { status: 409 }),
    );
    await expect(stale.submitCheckout(review())).resolves.toEqual({
      kind: 'offer-changed',
    });

    const missingTerms = createBillingUiHttpTransport(async () =>
      Response.json({ error: 'terms-consent-required' }, { status: 422 }),
    );
    await expect(missingTerms.submitCheckout(review())).resolves.toEqual({
      kind: 'terms-changed',
    });
  });

  it('keeps cancellation confirmation, retry, and local not-found distinct', async () => {
    const confirmed = createBillingUiHttpTransport(async () =>
      Response.json({
        status: 'cancellation-scheduled',
        outcome: 'scheduled',
        confirmedAt: 2_000,
        accessEndsAt: 3_000,
      }),
    );
    await expect(
      confirmed.cancelSubscription(createBillingCancellationIdempotencyKey()),
    ).resolves.toEqual({
      kind: 'confirmed',
      outcome: 'scheduled',
      confirmedAt: 2_000,
      accessEndsAt: 3_000,
    });

    const immediate = createBillingUiHttpTransport(async () =>
      Response.json({
        status: 'cancelled',
        outcome: 'cancelled',
        confirmedAt: 2_000,
        accessEndsAt: 2_000,
      }),
    );
    await expect(
      immediate.cancelSubscription(createBillingCancellationIdempotencyKey()),
    ).resolves.toEqual({ kind: 'unavailable' });

    const unrenderableDate = createBillingUiHttpTransport(async () =>
      Response.json({
        status: 'cancellation-scheduled',
        outcome: 'scheduled',
        confirmedAt: 2_000,
        accessEndsAt: 8_640_000_000_000_001,
      }),
    );
    await expect(
      unrenderableDate.cancelSubscription(
        createBillingCancellationIdempotencyKey(),
      ),
    ).resolves.toEqual({ kind: 'unavailable' });

    const unavailable = createBillingUiHttpTransport(async () =>
      Response.json({ error: 'unavailable' }, { status: 503 }),
    );
    await expect(
      unavailable.cancelSubscription(createBillingCancellationIdempotencyKey()),
    ).resolves.toEqual({ kind: 'unavailable' });

    const local = createBillingUiHttpTransport(async () =>
      Response.json({ error: 'not-found' }, { status: 404 }),
    );
    await expect(local.loadOffer()).resolves.toEqual({ kind: 'not-found' });
  });

  it('creates server-decodable non-sensitive identifiers at the client edge', () => {
    expect(createBillingCheckoutSubmissionId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(createBillingCancellationIdempotencyKey()).toMatch(
      /^cancel_[0-9a-f]{32}$/,
    );
  });
});

function contractOffer() {
  const offer = planContractOffer(contractDisclosure());
  if (offer.kind === 'rejected') throw new Error('invalid fixture');
  return offer.offer;
}

function review(): BillingCheckoutReview {
  return {
    offer: contractOffer(),
    offerHash: contractIds.offerHashA,
    terms: {
      termsVersion: 'terms-v1:2026-09-15',
      termsHash: `sha256:${'a'.repeat(64)}`,
      effectiveDate: '2026-09-15',
    },
    submissionId: contractIds.submissionA,
  };
}

function requestLabel(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}
