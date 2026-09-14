import { describe, expect, it } from 'vitest';
import {
  billingCancellationUiReducer,
  billingCheckoutUiReducer,
  billingUiOfferFromDisclosure,
  billingUiPeriodLabel,
  formatBillingUiYen,
  initialBillingCancellationUiState,
  initialBillingCheckoutUiState,
  type BillingCheckoutReview,
} from '@/lib/application/billing-ui';
import { planContractOffer } from '@/server/legal-checkout/core';
import {
  contractDisclosure,
  contractIds,
} from '@/tests/fixtures/legal-checkout';

describe('billing checkout UI pure state', () => {
  it('requires a fresh affirmative choice before entering one submitting state', () => {
    const loaded = billingCheckoutUiReducer(initialBillingCheckoutUiState, {
      type: 'offer-loaded',
      review: review(),
      notice: null,
    });
    expect(loaded).toMatchObject({ kind: 'review', consent: false });
    expect(billingCheckoutUiReducer(loaded, { type: 'submit-requested' })).toBe(
      loaded,
    );

    const consented = billingCheckoutUiReducer(loaded, {
      type: 'consent-changed',
      consent: true,
    });
    const submitting = billingCheckoutUiReducer(consented, {
      type: 'submit-requested',
    });
    expect(submitting).toMatchObject({
      kind: 'submitting',
      review: { submissionId: contractIds.submissionA },
    });
    expect(
      billingCheckoutUiReducer(submitting, { type: 'submit-requested' }),
    ).toBe(submitting);
  });

  it('reuses the submission ID after retryable failure but resets consent for a changed offer', () => {
    const submitting = submittingState();
    const retry = billingCheckoutUiReducer(submitting, {
      type: 'submit-failed',
      failure: 'unavailable',
    });
    expect(retry).toMatchObject({
      kind: 'review',
      consent: true,
      review: { submissionId: contractIds.submissionA },
    });

    const loading = billingCheckoutUiReducer(submitting, {
      type: 'offer-changed',
    });
    expect(loading).toEqual({ kind: 'loading', reason: 'offer-changed' });
    const refreshed = billingCheckoutUiReducer(loading, {
      type: 'offer-loaded',
      review: { ...review(), submissionId: contractIds.submissionB },
      notice: 'offer-changed',
    });
    expect(refreshed).toMatchObject({
      kind: 'review',
      consent: false,
      notice: 'offer-changed',
      review: { submissionId: contractIds.submissionB },
    });
  });

  it('keeps the accepted offer visible before provider navigation and supports re-review', () => {
    const ready = billingCheckoutUiReducer(submittingState(), {
      type: 'provider-ready',
      checkoutUrl: 'https://checkout.stripe.com/c/pay/cs_test_fukamu',
      evidenceOutcome: 'recorded',
    });
    expect(ready).toMatchObject({
      kind: 'provider-ready',
      review: { offer: { trialDays: 14, firstChargeDay: 15 } },
    });
    expect(
      billingCheckoutUiReducer(ready, { type: 'review-again' }),
    ).toMatchObject({ kind: 'review', consent: false });
  });

  it('formats only the supported billing cadence and tax-inclusive yen values', () => {
    expect(formatBillingUiYen(15_360)).toBe('15,360円（税込）');
    expect(billingUiPeriodLabel('monthly')).toBe('毎月');
    expect(billingUiPeriodLabel('annual')).toBe('毎年');
  });

  it('keeps the local display offer compatible with the server contract offer', () => {
    const disclosure = contractDisclosure();
    const serverOffer = planContractOffer(disclosure);
    if (serverOffer.kind === 'rejected') throw new Error('invalid fixture');
    const uiOffer = billingUiOfferFromDisclosure(disclosure);
    if (uiOffer === undefined) throw new Error('invalid UI fixture');
    expect(serverOffer.offer).toMatchObject(uiOffer);
  });
});

describe('billing cancellation UI pure state', () => {
  it('requires confirmation and only displays completion after confirmation', () => {
    const confirming = billingCancellationUiReducer(
      initialBillingCancellationUiState,
      { type: 'confirmation-requested' },
    );
    const submitting = billingCancellationUiReducer(confirming, {
      type: 'submit-requested',
    });
    expect(submitting).toEqual({ kind: 'submitting' });
    expect(
      billingCancellationUiReducer(submitting, {
        type: 'submit-failed',
        failure: 'unavailable',
      }),
    ).toEqual({ kind: 'confirming', failure: 'unavailable' });
    expect(
      billingCancellationUiReducer(submitting, {
        type: 'confirmed',
        source: 'server',
        confirmedAt: 2_000,
      }),
    ).toEqual({ kind: 'confirmed', source: 'server', confirmedAt: 2_000 });
  });
});

function review(): BillingCheckoutReview {
  const offer = planContractOffer(contractDisclosure());
  if (offer.kind === 'rejected') throw new Error('invalid fixture');
  return {
    offer: offer.offer,
    offerHash: contractIds.offerHashA,
    submissionId: contractIds.submissionA,
  };
}

function submittingState() {
  const loaded = billingCheckoutUiReducer(initialBillingCheckoutUiState, {
    type: 'offer-loaded',
    review: review(),
    notice: null,
  });
  const consented = billingCheckoutUiReducer(loaded, {
    type: 'consent-changed',
    consent: true,
  });
  return billingCheckoutUiReducer(consented, { type: 'submit-requested' });
}
