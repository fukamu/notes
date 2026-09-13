import type {
  StripeCheckoutCreateCommand,
  StripeSubscriptionSnapshotRequest,
} from './core';

export type StripeTransportPort = {
  createCheckoutSession(command: StripeCheckoutCreateCommand): Promise<unknown>;
  retrieveSubscriptionSnapshot(
    request: StripeSubscriptionSnapshotRequest,
  ): Promise<unknown>;
};

export type StripeWebhookVerificationResult =
  | { readonly kind: 'verified'; readonly rawBody: Uint8Array }
  | { readonly kind: 'rejected' };

export type StripeWebhookVerifierPort = {
  verify(input: {
    readonly rawBody: Uint8Array;
    readonly signatureHeader: unknown;
    readonly receivedAt: number;
  }): Promise<StripeWebhookVerificationResult>;
};
