import { objectDecoder } from '@/lib/codec/core';
import { sessionMetadataFromRequest } from '@/server/adapters/web-session';
import {
  subscriptionCancellationIdempotencyKeyDecoder,
  type SubscriptionCancellationPort,
  type SubscriptionCancellationResult,
} from '@/server/billing/public';
import {
  deriveVaultContext,
  type SessionCredentialResolver,
} from '@/server/session-boundary';
import {
  billingErrorResponse,
  billingNoStoreHeaders,
  readBillingClock,
  readBillingJson,
  unexpectedBillingFailure,
} from '../http';

const cancellationRequestDecoder = objectDecoder({
  idempotencyKey: subscriptionCancellationIdempotencyKeyDecoder,
});

export type SubscriptionCancellationHttpDependencies = {
  readonly expectedOrigin: unknown;
  readonly clock: { now(): unknown };
  readonly sessions: SessionCredentialResolver;
  readonly cancellation: SubscriptionCancellationPort;
};

export function createSubscriptionCancellationHandler(
  dependencies: SubscriptionCancellationHttpDependencies,
) {
  return async function handleSubscriptionCancellation(
    request: Request,
  ): Promise<Response> {
    const now = readBillingClock(dependencies.clock);
    if (now === undefined) return billingErrorResponse(503, 'unavailable');

    let session;
    try {
      session = await deriveVaultContext(
        sessionMetadataFromRequest(request, {
          expectedOrigin: dependencies.expectedOrigin,
          now,
        }),
        dependencies.sessions,
      );
    } catch {
      return unexpectedBillingFailure('cancellation');
    }
    if (session.kind === 'anonymous') {
      return billingErrorResponse(401, 'authentication-required');
    }
    if (session.kind === 'forbidden') {
      return billingErrorResponse(403, 'forbidden');
    }

    const body = await readBillingJson(request);
    if (body.kind === 'too-large') {
      return billingErrorResponse(413, 'request-too-large');
    }
    if (body.kind === 'invalid') {
      return billingErrorResponse(400, 'invalid-request');
    }
    const decoded = cancellationRequestDecoder.decode(body.value);
    if (!decoded.ok) return billingErrorResponse(400, 'invalid-request');

    let result: SubscriptionCancellationResult;
    try {
      result = await dependencies.cancellation.cancelSubscription({
        accountId: session.context.accountId,
        vaultId: session.context.vaultId,
        idempotencyKey: decoded.value.idempotencyKey,
        requestedAt: now,
      });
    } catch {
      return unexpectedBillingFailure('cancellation');
    }
    return cancellationResponse(result);
  };
}

function cancellationResponse(
  result: SubscriptionCancellationResult,
): Response {
  switch (result.kind) {
    case 'confirmed':
      return Response.json(
        {
          status: 'cancelled',
          outcome: result.outcome,
          confirmedAt: result.confirmedAt,
        },
        { headers: billingNoStoreHeaders },
      );
    case 'retryable-failure':
      return billingErrorResponse(503, 'unavailable');
    case 'terminal-failure':
      switch (result.reason) {
        case 'invalid-command':
          return billingErrorResponse(400, 'invalid-request');
        case 'owner-mismatch':
          return billingErrorResponse(403, 'forbidden');
        case 'subscription-not-found':
        case 'provider-not-linked':
        case 'provider-terminal':
          return billingErrorResponse(409, 'cancellation-unavailable');
      }
  }
}
