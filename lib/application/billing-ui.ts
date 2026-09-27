import type { LegalCommerceDisclosure } from '@/lib/application/legal-commerce';
import type { TermsConsentUiReference } from '@/lib/application/terms-consent-ui';
import type { ContractSubmissionId } from '@/lib/contracts/contract-checkout';
import type { TermsConsentSubmissionId } from '@/lib/contracts/terms-consent';

export type BillingUiOffer = Readonly<{
  offerVersion: string;
  disclosureVersion: string;
  serviceName: 'FUKAMU Notes';
  quantity: 'one-personal-vault';
  planName: string;
  priceYen: number;
  billingPeriod: 'monthly' | 'annual';
  taxIncluded: true;
  trialDays: 14;
  trialPriceYen: 0;
  firstChargeDay: 15;
  renewalChargeYen: number;
  annualEstimateYen: number;
  automaticRenewal: true;
  paymentMethod: 'credit-card';
  serviceStart: 'after-registration-and-payment-method-confirmation';
  servicePeriod: 'indefinite-until-cancelled';
  cancellationPolicy: string;
  refundPolicy: string;
  additionalFees: string;
  onlineLockPolicy: 'immediate-on-payment-failure-or-action-required';
  cancellationSeparateFromAccountDeletion: true;
}>;

export type BillingCheckoutReview = Readonly<{
  offer: BillingUiOffer;
  offerHash: string;
  terms: TermsConsentUiReference;
  submissionId: ContractSubmissionId;
  termsSubmissionId: TermsConsentSubmissionId;
}>;

export type BillingCheckoutFailure =
  | 'authentication-required'
  | 'request-conflict'
  | 'unavailable';

export type BillingCheckoutUiState =
  | {
      readonly kind: 'loading';
      readonly reason: 'initial' | 'offer-changed' | 'terms-changed';
    }
  | {
      readonly kind: 'review';
      readonly review: BillingCheckoutReview;
      readonly subscriptionConsent: boolean;
      readonly termsConsent: boolean;
      readonly failure: BillingCheckoutFailure | null;
      readonly notice: 'offer-changed' | 'terms-changed' | null;
    }
  | {
      readonly kind: 'submitting';
      readonly review: BillingCheckoutReview;
    }
  | {
      readonly kind: 'provider-ready';
      readonly review: BillingCheckoutReview;
      readonly checkoutUrl: string;
      readonly evidenceOutcome: 'recorded' | 'replayed';
    }
  | {
      readonly kind: 'local-confirmed';
      readonly review: BillingCheckoutReview;
    }
  | {
      readonly kind: 'unavailable';
      readonly failure: 'authentication-required' | 'unavailable';
    };

export type BillingCheckoutUiAction =
  | {
      readonly type: 'offer-loaded';
      readonly review: BillingCheckoutReview;
      readonly notice: 'offer-changed' | 'terms-changed' | null;
    }
  | {
      readonly type: 'offer-load-failed';
      readonly failure: 'authentication-required' | 'unavailable';
    }
  | {
      readonly type: 'consent-changed';
      readonly subject: 'subscription' | 'terms';
      readonly consent: boolean;
    }
  | { readonly type: 'submit-requested' }
  | {
      readonly type: 'submit-failed';
      readonly failure: BillingCheckoutFailure;
    }
  | { readonly type: 'offer-changed' }
  | { readonly type: 'terms-changed' }
  | {
      readonly type: 'provider-ready';
      readonly checkoutUrl: string;
      readonly evidenceOutcome: 'recorded' | 'replayed';
    }
  | { readonly type: 'local-confirmed' }
  | { readonly type: 'review-again' };

export const initialBillingCheckoutUiState: BillingCheckoutUiState = {
  kind: 'loading',
  reason: 'initial',
};

export function billingCheckoutUiReducer(
  state: BillingCheckoutUiState,
  action: BillingCheckoutUiAction,
): BillingCheckoutUiState {
  switch (action.type) {
    case 'offer-loaded':
      return {
        kind: 'review',
        review: action.review,
        subscriptionConsent: false,
        termsConsent: false,
        failure: null,
        notice: action.notice,
      };
    case 'offer-load-failed':
      return { kind: 'unavailable', failure: action.failure };
    case 'consent-changed':
      return state.kind === 'review'
        ? {
            ...state,
            [action.subject === 'subscription'
              ? 'subscriptionConsent'
              : 'termsConsent']: action.consent,
            failure: null,
          }
        : state;
    case 'submit-requested':
      return state.kind === 'review' &&
        state.subscriptionConsent &&
        state.termsConsent
        ? { kind: 'submitting', review: state.review }
        : state;
    case 'submit-failed':
      return state.kind === 'submitting'
        ? {
            kind: 'review',
            review: state.review,
            subscriptionConsent: true,
            termsConsent: true,
            failure: action.failure,
            notice: null,
          }
        : state;
    case 'offer-changed':
      return state.kind === 'submitting'
        ? { kind: 'loading', reason: 'offer-changed' }
        : state;
    case 'terms-changed':
      return state.kind === 'submitting'
        ? { kind: 'loading', reason: 'terms-changed' }
        : state;
    case 'provider-ready':
      return state.kind === 'submitting'
        ? {
            kind: 'provider-ready',
            review: state.review,
            checkoutUrl: action.checkoutUrl,
            evidenceOutcome: action.evidenceOutcome,
          }
        : state;
    case 'local-confirmed':
      return state.kind === 'submitting'
        ? { kind: 'local-confirmed', review: state.review }
        : state;
    case 'review-again':
      return state.kind === 'provider-ready' || state.kind === 'local-confirmed'
        ? {
            kind: 'review',
            review: state.review,
            subscriptionConsent: false,
            termsConsent: false,
            failure: null,
            notice: null,
          }
        : state;
  }
}

export type BillingCancellationFailure =
  | 'authentication-required'
  | 'cancellation-unavailable'
  | 'unavailable';

export type BillingCancellationUiState =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'confirming';
      readonly failure: BillingCancellationFailure | null;
    }
  | { readonly kind: 'submitting' }
  | {
      readonly kind: 'confirmed';
      readonly source: 'server' | 'local-fixture';
      readonly confirmedAt: number | null;
    };

export type BillingCancellationUiAction =
  | { readonly type: 'confirmation-requested' }
  | { readonly type: 'confirmation-cancelled' }
  | { readonly type: 'submit-requested' }
  | {
      readonly type: 'submit-failed';
      readonly failure: BillingCancellationFailure;
    }
  | {
      readonly type: 'confirmed';
      readonly source: 'server' | 'local-fixture';
      readonly confirmedAt: number | null;
    };

export const initialBillingCancellationUiState: BillingCancellationUiState = {
  kind: 'idle',
};

export function billingCancellationUiReducer(
  state: BillingCancellationUiState,
  action: BillingCancellationUiAction,
): BillingCancellationUiState {
  switch (action.type) {
    case 'confirmation-requested':
      return state.kind === 'idle'
        ? { kind: 'confirming', failure: null }
        : state;
    case 'confirmation-cancelled':
      return state.kind === 'confirming' ? { kind: 'idle' } : state;
    case 'submit-requested':
      return state.kind === 'confirming' ? { kind: 'submitting' } : state;
    case 'submit-failed':
      return state.kind === 'submitting'
        ? { kind: 'confirming', failure: action.failure }
        : state;
    case 'confirmed':
      return state.kind === 'submitting'
        ? {
            kind: 'confirmed',
            source: action.source,
            confirmedAt: action.confirmedAt,
          }
        : state;
  }
}

export function formatBillingUiYen(value: number): string {
  return `${String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}円（税込）`;
}

export function billingUiPeriodLabel(
  billingPeriod: BillingUiOffer['billingPeriod'],
): string {
  return billingPeriod === 'monthly' ? '毎月' : '毎年';
}

export function billingUiOfferFromDisclosure(
  disclosure: LegalCommerceDisclosure,
): BillingUiOffer | undefined {
  const annualEstimateYen =
    disclosure.offer.billingPeriod === 'monthly'
      ? disclosure.offer.priceYen * 12
      : disclosure.offer.priceYen;
  if (
    !Number.isSafeInteger(annualEstimateYen) ||
    annualEstimateYen < disclosure.offer.priceYen
  ) {
    return undefined;
  }
  return {
    offerVersion: `legal-commerce-v1:${disclosure.effectiveDate}`,
    disclosureVersion: disclosure.effectiveDate,
    serviceName: 'FUKAMU Notes',
    quantity: 'one-personal-vault',
    planName: disclosure.offer.planName,
    priceYen: disclosure.offer.priceYen,
    billingPeriod: disclosure.offer.billingPeriod,
    taxIncluded: true,
    trialDays: 14,
    trialPriceYen: 0,
    firstChargeDay: 15,
    renewalChargeYen: disclosure.offer.priceYen,
    annualEstimateYen,
    automaticRenewal: true,
    paymentMethod: 'credit-card',
    serviceStart: 'after-registration-and-payment-method-confirmation',
    servicePeriod: 'indefinite-until-cancelled',
    cancellationPolicy: disclosure.cancellationPolicy,
    refundPolicy: disclosure.refundPolicy,
    additionalFees: disclosure.additionalFees,
    onlineLockPolicy: 'immediate-on-payment-failure-or-action-required',
    cancellationSeparateFromAccountDeletion: true,
  };
}
