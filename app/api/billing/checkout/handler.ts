import { sessionMetadataFromRequest } from '@/server/adapters/web-session';
import {
  contractConfirmationCommandDecoder,
  contractEvidenceIdDecoder,
  type ContractCheckoutApplication,
  type ContractCheckoutResult,
} from '@/server/legal-checkout/public';
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

export type ContractCheckoutHttpDependencies = {
  readonly expectedOrigin: unknown;
  readonly clock: { now(): unknown };
  readonly ids: { createEvidenceId(): unknown };
  readonly sessions: SessionCredentialResolver;
  readonly application: ContractCheckoutApplication;
};

export function createContractOfferHandler(
  dependencies: Omit<ContractCheckoutHttpDependencies, 'ids'>,
) {
  return async function handleContractOffer(
    request: Request,
  ): Promise<Response> {
    const now = readBillingClock(dependencies.clock);
    if (now === undefined) return billingErrorResponse(503, 'unavailable');
    const session = await authenticatedSession(request, dependencies, now);
    if (session.kind === 'response') return session.response;

    let result;
    try {
      result = await dependencies.application.prepareOffer();
    } catch {
      return unexpectedBillingFailure('checkout');
    }
    if (result.kind === 'unavailable') {
      return billingErrorResponse(503, 'unavailable');
    }
    return Response.json(
      {
        offer: result.prepared.offer,
        offerHash: result.prepared.offerHash,
      },
      { headers: billingNoStoreHeaders },
    );
  };
}

export function createContractCheckoutHandler(
  dependencies: ContractCheckoutHttpDependencies,
) {
  return async function handleContractCheckout(
    request: Request,
  ): Promise<Response> {
    const now = readBillingClock(dependencies.clock);
    if (now === undefined) return billingErrorResponse(503, 'unavailable');
    const session = await authenticatedSession(request, dependencies, now);
    if (session.kind === 'response') return session.response;

    const body = await readBillingJson(request);
    if (body.kind === 'too-large') {
      return billingErrorResponse(413, 'request-too-large');
    }
    if (body.kind === 'invalid') {
      return billingErrorResponse(400, 'invalid-request');
    }
    const command = contractConfirmationCommandDecoder.decode(body.value);
    if (!command.ok) return billingErrorResponse(400, 'invalid-request');

    let evidenceCandidate: unknown;
    try {
      evidenceCandidate = dependencies.ids.createEvidenceId();
    } catch {
      return unexpectedBillingFailure('checkout');
    }
    const evidenceId = contractEvidenceIdDecoder.decode(evidenceCandidate);
    if (!evidenceId.ok) return billingErrorResponse(503, 'unavailable');

    let result: ContractCheckoutResult;
    try {
      result = await dependencies.application.confirm({
        context: session.context,
        command: command.value,
        evidenceId: evidenceId.value,
        confirmedAt: now,
      });
    } catch {
      return unexpectedBillingFailure('checkout');
    }
    return checkoutResponse(result);
  };
}

async function authenticatedSession(
  request: Request,
  dependencies: Pick<
    ContractCheckoutHttpDependencies,
    'expectedOrigin' | 'sessions'
  >,
  now: number,
): Promise<
  | {
      readonly kind: 'authenticated';
      readonly context: Extract<
        Awaited<ReturnType<typeof deriveVaultContext>>,
        { readonly kind: 'authenticated' }
      >['context'];
    }
  | { readonly kind: 'response'; readonly response: Response }
> {
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
    return { kind: 'response', response: unexpectedBillingFailure('checkout') };
  }
  if (session.kind === 'anonymous') {
    return {
      kind: 'response',
      response: billingErrorResponse(401, 'authentication-required'),
    };
  }
  if (session.kind === 'forbidden') {
    return {
      kind: 'response',
      response: billingErrorResponse(403, 'forbidden'),
    };
  }
  return session;
}

function checkoutResponse(result: ContractCheckoutResult): Response {
  if (result.kind === 'redirect') {
    return Response.json(
      {
        kind: result.kind,
        evidenceOutcome: result.evidenceOutcome,
        evidenceId: result.evidence.evidenceId,
        offerHash: result.evidence.offerHash,
        offerVersion: result.evidence.offer.offerVersion,
        checkoutUrl: result.checkoutUrl,
      },
      { headers: billingNoStoreHeaders },
    );
  }
  switch (result.reason) {
    case 'invalid-command':
      return billingErrorResponse(400, 'invalid-request');
    case 'consent-required':
      return billingErrorResponse(422, 'consent-required');
    case 'stale-offer':
      return billingErrorResponse(409, 'offer-changed');
    case 'terms-changed':
      return billingErrorResponse(409, 'terms-changed');
    case 'terms-consent-required':
      return billingErrorResponse(422, 'terms-consent-required');
    case 'identifier-conflict':
    case 'billing-rejected':
      return billingErrorResponse(409, 'request-conflict');
    case 'owner-mismatch':
      return billingErrorResponse(403, 'forbidden');
    case 'invalid-offer':
    case 'hash-unavailable':
    case 'unavailable':
    case 'provider-unavailable':
    case 'malformed-provider-response':
    case 'provider-mapping-mismatch':
      return billingErrorResponse(503, 'unavailable');
  }
}
