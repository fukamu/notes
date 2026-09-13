import type { BillingApi, ProviderFactResult } from '../billing/public';
import {
  STRIPE_MAX_WEBHOOK_BYTES,
  STRIPE_PROVIDER,
  decodeStripeCheckoutResponse,
  decodeStripeEventPlan,
  decodeStripeReconciliationSnapshot,
  planStripeCheckout,
  type StripeSnapshotPlan,
} from './core';
import type { StripeTransportPort, StripeWebhookVerifierPort } from './ports';
import type {
  HostedCheckoutResult,
  StripeBillingAdapter,
  StripeBillingConfiguration,
  StripeWebhookResult,
} from './public';

export function createStripeBillingAdapter(dependencies: {
  readonly configuration: StripeBillingConfiguration;
  readonly billing: BillingApi;
  readonly transport: StripeTransportPort;
  readonly webhookVerifier: StripeWebhookVerifierPort;
}): StripeBillingAdapter {
  return {
    async beginHostedCheckout(context, command): Promise<HostedCheckoutResult> {
      let began: Awaited<ReturnType<BillingApi['beginCheckout']>>;
      try {
        began = await dependencies.billing.beginCheckout(context, {
          subscriptionId: command.subscriptionId,
          checkoutIntentId: command.checkoutIntentId,
          provider: STRIPE_PROVIDER,
          createdAt: command.createdAt,
        });
      } catch {
        return { kind: 'rejected', reason: 'billing-rejected' };
      }
      if (began.kind === 'rejected') {
        return {
          kind: 'rejected',
          reason:
            began.reason === 'invalid-transition'
              ? 'invalid-input'
              : 'billing-rejected',
        };
      }

      let rawResponse: unknown;
      try {
        rawResponse = await dependencies.transport.createCheckoutSession(
          planStripeCheckout(dependencies.configuration, command),
        );
      } catch {
        return { kind: 'rejected', reason: 'provider-unavailable' };
      }
      const response = decodeStripeCheckoutResponse(rawResponse, {
        mode: dependencies.configuration.mode,
        subscriptionId: command.subscriptionId,
        checkoutIntentId: command.checkoutIntentId,
      });
      if (response === undefined) {
        return { kind: 'rejected', reason: 'malformed-provider-response' };
      }
      let opened: Awaited<ReturnType<BillingApi['recordCheckoutOpened']>>;
      try {
        opened = await dependencies.billing.recordCheckoutOpened(context, {
          subscriptionId: command.subscriptionId,
          checkoutIntentId: command.checkoutIntentId,
          providerCheckoutReference: response.providerCheckoutReference,
          openedAt: command.createdAt,
        });
      } catch {
        return { kind: 'rejected', reason: 'billing-rejected' };
      }
      if (opened.kind === 'rejected') {
        return {
          kind: 'rejected',
          reason:
            opened.reason === 'identifier-conflict'
              ? 'provider-mapping-mismatch'
              : 'billing-rejected',
        };
      }
      return {
        kind: 'redirect',
        checkoutUrl: response.checkoutUrl,
        providerCheckoutReference: response.providerCheckoutReference,
      };
    },

    async ingestWebhook(request): Promise<StripeWebhookResult> {
      if (
        !(request.rawBody instanceof Uint8Array) ||
        request.rawBody.byteLength === 0 ||
        request.rawBody.byteLength > STRIPE_MAX_WEBHOOK_BYTES
      ) {
        return { kind: 'rejected', reason: 'malformed-event' };
      }
      let verification;
      try {
        verification = await dependencies.webhookVerifier.verify(request);
      } catch {
        return { kind: 'rejected', reason: 'invalid-signature' };
      }
      if (verification.kind === 'rejected') {
        return { kind: 'rejected', reason: 'invalid-signature' };
      }
      const payload = parseJsonUtf8(verification.rawBody);
      if (payload.kind === 'rejected') return payload;
      const plan = decodeStripeEventPlan(payload.value, {
        mode: dependencies.configuration.mode,
        apiVersion: dependencies.configuration.apiVersion,
        receivedAt: request.receivedAt,
      });
      switch (plan.kind) {
        case 'unsupported':
          return { kind: 'ignored', reason: 'unsupported-event' };
        case 'rejected':
          return plan;
        case 'fact':
          return ingestFact(dependencies.billing, plan.fact);
        case 'snapshot':
          return retrieveAndReconcile(dependencies, plan.plan);
      }
    },

    async reconcileSubscription(command): Promise<StripeWebhookResult> {
      return retrieveAndReconcile(dependencies, {
        snapshotId: command.snapshotId,
        subscriptionId: command.subscriptionId,
        providerSubscriptionReference: command.providerSubscriptionReference,
        observedAt: command.observedAt,
        recordedAt: command.recordedAt,
      });
    },
  };
}

async function retrieveAndReconcile(
  dependencies: {
    readonly configuration: StripeBillingConfiguration;
    readonly billing: BillingApi;
    readonly transport: StripeTransportPort;
  },
  plan: StripeSnapshotPlan,
): Promise<StripeWebhookResult> {
  let input: unknown;
  try {
    input = await dependencies.transport.retrieveSubscriptionSnapshot({
      apiVersion: dependencies.configuration.apiVersion,
      providerSubscriptionReference: plan.providerSubscriptionReference,
    });
  } catch {
    return { kind: 'rejected', reason: 'provider-unavailable' };
  }
  const snapshot = decodeStripeReconciliationSnapshot(input, plan);
  if (snapshot === undefined) {
    return { kind: 'rejected', reason: 'malformed-event' };
  }
  try {
    return providerResult(
      await dependencies.billing.reconcileVerifiedSnapshot(snapshot),
    );
  } catch {
    return { kind: 'rejected', reason: 'billing-rejected' };
  }
}

async function ingestFact(
  billing: BillingApi,
  fact: Parameters<BillingApi['ingestVerifiedProviderFact']>[0],
): Promise<StripeWebhookResult> {
  try {
    return providerResult(await billing.ingestVerifiedProviderFact(fact));
  } catch {
    return { kind: 'rejected', reason: 'billing-rejected' };
  }
}

function providerResult(result: ProviderFactResult): StripeWebhookResult {
  return result.kind === 'rejected'
    ? { kind: 'rejected', reason: 'billing-rejected' }
    : { kind: 'accepted', outcome: result.kind };
}

function parseJsonUtf8(
  rawBody: Uint8Array,
):
  | { readonly kind: 'parsed'; readonly value: unknown }
  | { readonly kind: 'rejected'; readonly reason: 'malformed-event' } {
  try {
    const text = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(rawBody);
    const value: unknown = JSON.parse(text);
    return { kind: 'parsed', value };
  } catch {
    return { kind: 'rejected', reason: 'malformed-event' };
  }
}
