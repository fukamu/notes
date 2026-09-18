import type {
  StripeCheckoutCreateCommand,
  StripeSubscriptionSnapshotRequest,
} from './core';
import type { StripeTransportPort, StripeWebhookVerifierPort } from './ports';

export type FakeStripeTransport = StripeTransportPort & {
  readonly checkoutCommands: () => readonly StripeCheckoutCreateCommand[];
  readonly snapshotRequests: () => readonly StripeSubscriptionSnapshotRequest[];
};

export function createFakeStripeTransport(input: {
  readonly checkoutResponse: unknown;
  readonly snapshots: ReadonlyMap<string, unknown>;
  readonly loseFirstCheckoutResponse?: boolean;
}): FakeStripeTransport {
  const checkoutCommands: StripeCheckoutCreateCommand[] = [];
  const snapshotRequests: StripeSubscriptionSnapshotRequest[] = [];
  const responses = new Map<string, unknown>();
  let responseLost = false;
  return {
    async createCheckoutSession(command) {
      checkoutCommands.push(command);
      const key = command.idempotencyKey;
      const response = responses.get(key) ?? input.checkoutResponse;
      responses.set(key, response);
      if (input.loseFirstCheckoutResponse && !responseLost) {
        responseLost = true;
        throw new Error('simulated response loss');
      }
      return response;
    },
    async retrieveSubscriptionSnapshot(request) {
      snapshotRequests.push(request);
      const response = input.snapshots.get(
        request.providerSubscriptionReference,
      );
      if (response === undefined) throw new Error('unknown fake subscription');
      return response;
    },
    checkoutCommands() {
      return [...checkoutCommands];
    },
    snapshotRequests() {
      return [...snapshotRequests];
    },
  };
}

export function createFakeStripeWebhookVerifier(
  acceptedHeader = 'fake-stripe-signature',
): StripeWebhookVerifierPort {
  return {
    async verify(input) {
      return input.signatureHeader === acceptedHeader
        ? { kind: 'verified', rawBody: Uint8Array.from(input.rawBody) }
        : { kind: 'rejected' };
    },
  };
}
