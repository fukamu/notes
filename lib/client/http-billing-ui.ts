import { v7 as uuidv7 } from 'uuid';
import {
  literalDecoder,
  objectDecoder,
  refineDecoder,
  safeIntegerDecoder,
  stringDecoder,
  unionDecoder,
} from '@/lib/codec/core';
import type {
  BillingCheckoutReview,
  BillingUiOffer,
} from '@/lib/application/billing-ui';
import {
  parseSubscriptionCancellationIdempotencyKey,
  type SubscriptionCancellationIdempotencyKey,
} from '@/lib/contracts/billing-cancellation';
import { decideBrowserExternalDestination } from '@/lib/application/external-transmission';
import {
  contractEvidenceIdDecoder,
  contractOfferHashDecoder,
  contractOfferSnapshotDecoder,
  parseContractSubmissionId,
} from '@/lib/contracts/contract-checkout';

type FetchRequest = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type BillingOfferLoadResult =
  | {
      readonly kind: 'available';
      readonly offer: BillingUiOffer;
      readonly offerHash: string;
    }
  | { readonly kind: 'authentication-required' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable' };

export type BillingCheckoutSubmitResult =
  | {
      readonly kind: 'provider-ready';
      readonly checkoutUrl: string;
      readonly evidenceOutcome: 'recorded' | 'replayed';
    }
  | {
      readonly kind: 'local-confirmed';
      readonly evidenceOutcome: 'recorded' | 'replayed';
    }
  | { readonly kind: 'offer-changed' }
  | { readonly kind: 'terms-changed' }
  | { readonly kind: 'authentication-required' }
  | { readonly kind: 'request-conflict' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable' };

export type BillingCancellationResult =
  | {
      readonly kind: 'confirmed';
      readonly confirmedAt: number;
      readonly accessEndsAt: number;
      readonly outcome: 'scheduled' | 'already-cancelled';
    }
  | { readonly kind: 'authentication-required' }
  | { readonly kind: 'cancellation-unavailable' }
  | { readonly kind: 'not-found' }
  | { readonly kind: 'unavailable' };

export type BillingUiHttpTransport = Readonly<{
  loadOffer(): Promise<BillingOfferLoadResult>;
  submitCheckout(
    review: BillingCheckoutReview,
  ): Promise<BillingCheckoutSubmitResult>;
  cancelSubscription(
    idempotencyKey: SubscriptionCancellationIdempotencyKey,
  ): Promise<BillingCancellationResult>;
}>;

const offerResponseDecoder = objectDecoder({
  offer: contractOfferSnapshotDecoder,
  offerHash: contractOfferHashDecoder,
});

const redirectCheckoutResponseDecoder = objectDecoder({
  kind: literalDecoder('redirect'),
  evidenceOutcome: unionDecoder(
    literalDecoder('recorded'),
    literalDecoder('replayed'),
  ),
  evidenceId: contractEvidenceIdDecoder,
  offerHash: contractOfferHashDecoder,
  offerVersion: stringDecoder({ minLength: 1, maxLength: 128 }),
  checkoutUrl: refineDecoder(
    stringDecoder({ minLength: 1, maxLength: 2_048 }),
    isTrustedCheckoutUrl,
    'expected a Stripe Checkout URL',
  ),
});

const localCheckoutResponseDecoder = objectDecoder({
  kind: literalDecoder('local-confirmed'),
  evidenceOutcome: unionDecoder(
    literalDecoder('recorded'),
    literalDecoder('replayed'),
  ),
  evidenceId: contractEvidenceIdDecoder,
  offerHash: contractOfferHashDecoder,
  offerVersion: stringDecoder({ minLength: 1, maxLength: 128 }),
});

const checkoutResponseDecoder = unionDecoder(
  redirectCheckoutResponseDecoder,
  localCheckoutResponseDecoder,
);

const cancellationResponseDecoder = unionDecoder(
  objectDecoder({
    status: literalDecoder('cancellation-scheduled'),
    outcome: literalDecoder('scheduled'),
    confirmedAt: safeIntegerDecoder({ minimum: 0 }),
    accessEndsAt: safeIntegerDecoder({ minimum: 0 }),
  }),
  objectDecoder({
    status: literalDecoder('cancelled'),
    outcome: literalDecoder('already-cancelled'),
    confirmedAt: safeIntegerDecoder({ minimum: 0 }),
    accessEndsAt: safeIntegerDecoder({ minimum: 0 }),
  }),
);

const errorResponseDecoder = objectDecoder({
  error: unionDecoder(
    literalDecoder('authentication-required'),
    literalDecoder('forbidden'),
    literalDecoder('not-found'),
    literalDecoder('offer-changed'),
    literalDecoder('terms-changed'),
    literalDecoder('terms-consent-required'),
    literalDecoder('request-conflict'),
    literalDecoder('consent-required'),
    literalDecoder('cancellation-unavailable'),
    literalDecoder('invalid-request'),
    literalDecoder('request-too-large'),
    literalDecoder('unavailable'),
  ),
});

export function createBillingUiHttpTransport(
  fetchRequest: FetchRequest = fetch,
): BillingUiHttpTransport {
  return {
    async loadOffer() {
      const response = await request(fetchRequest, '/api/billing/checkout', {
        method: 'GET',
      });
      if (response === undefined) return { kind: 'unavailable' };
      if (!response.ok)
        return offerFailure(response.status, await body(response));
      const decoded = offerResponseDecoder.decode(await body(response));
      return decoded.ok
        ? {
            kind: 'available',
            offer: decoded.value.offer,
            offerHash: decoded.value.offerHash,
          }
        : { kind: 'unavailable' };
    },

    async submitCheckout(review) {
      const response = await request(fetchRequest, '/api/billing/checkout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          submissionId: review.submissionId,
          presentedOfferHash: review.offerHash,
          consent: { kind: 'affirmed' },
        }),
      });
      if (response === undefined) return { kind: 'unavailable' };
      if (!response.ok) {
        return checkoutFailure(response.status, await body(response));
      }
      const decoded = checkoutResponseDecoder.decode(await body(response));
      if (
        !decoded.ok ||
        decoded.value.offerHash !== review.offerHash ||
        decoded.value.offerVersion !== review.offer.offerVersion
      ) {
        return { kind: 'unavailable' };
      }
      return decoded.value.kind === 'redirect'
        ? {
            kind: 'provider-ready',
            checkoutUrl: decoded.value.checkoutUrl,
            evidenceOutcome: decoded.value.evidenceOutcome,
          }
        : {
            kind: 'local-confirmed',
            evidenceOutcome: decoded.value.evidenceOutcome,
          };
    },

    async cancelSubscription(idempotencyKey) {
      const response = await request(fetchRequest, '/api/billing/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idempotencyKey }),
      });
      if (response === undefined) return { kind: 'unavailable' };
      if (!response.ok) {
        return cancellationFailure(response.status, await body(response));
      }
      const decoded = cancellationResponseDecoder.decode(await body(response));
      return decoded.ok
        ? {
            kind: 'confirmed',
            confirmedAt: decoded.value.confirmedAt,
            accessEndsAt: decoded.value.accessEndsAt,
            outcome: decoded.value.outcome,
          }
        : { kind: 'unavailable' };
    },
  };
}

export function createBillingCheckoutSubmissionId(): string {
  return parseContractSubmissionId(uuidv7());
}

export function createBillingCancellationIdempotencyKey(): SubscriptionCancellationIdempotencyKey {
  return parseSubscriptionCancellationIdempotencyKey(
    `cancel_${uuidv7().replaceAll('-', '')}`,
  );
}

async function request(
  fetchRequest: FetchRequest,
  input: string,
  init: RequestInit,
): Promise<Response | undefined> {
  const headers = new Headers(init.headers);
  headers.set('Accept', 'application/json');
  try {
    return await fetchRequest(input, {
      ...init,
      cache: 'no-store',
      credentials: 'same-origin',
      headers,
    });
  } catch {
    return undefined;
  }
}

async function body(response: Response): Promise<unknown> {
  try {
    const value: unknown = await response.json();
    return value;
  } catch {
    return undefined;
  }
}

function offerFailure(status: number, input: unknown): BillingOfferLoadResult {
  const error = decodedError(input);
  if (status === 401 && error === 'authentication-required') {
    return { kind: 'authentication-required' };
  }
  if (status === 404 && error === 'not-found') return { kind: 'not-found' };
  return { kind: 'unavailable' };
}

function checkoutFailure(
  status: number,
  input: unknown,
): BillingCheckoutSubmitResult {
  const error = decodedError(input);
  if (status === 401 && error === 'authentication-required') {
    return { kind: 'authentication-required' };
  }
  if (status === 404 && error === 'not-found') return { kind: 'not-found' };
  if (status === 409 && error === 'offer-changed') {
    return { kind: 'offer-changed' };
  }
  if (
    (status === 409 && error === 'terms-changed') ||
    (status === 422 && error === 'terms-consent-required')
  ) {
    return { kind: 'terms-changed' };
  }
  if (status === 409 && error === 'request-conflict') {
    return { kind: 'request-conflict' };
  }
  return { kind: 'unavailable' };
}

function cancellationFailure(
  status: number,
  input: unknown,
): BillingCancellationResult {
  const error = decodedError(input);
  if (status === 401 && error === 'authentication-required') {
    return { kind: 'authentication-required' };
  }
  if (status === 404 && error === 'not-found') return { kind: 'not-found' };
  if (status === 409 && error === 'cancellation-unavailable') {
    return { kind: 'cancellation-unavailable' };
  }
  return { kind: 'unavailable' };
}

function decodedError(input: unknown) {
  const decoded = errorResponseDecoder.decode(input);
  return decoded.ok ? decoded.value.error : undefined;
}

function isTrustedCheckoutUrl(value: string): boolean {
  return (
    decideBrowserExternalDestination('stripe-checkout', value).kind ===
    'allowed'
  );
}
