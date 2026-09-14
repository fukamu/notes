import { nonNegativeSafeInteger } from '@/lib/domain/types';
import { sessionMetadataFromRequest } from '@/server/adapters/web-session';
import type {
  TermsConsentApplication,
  TermsConsentApplicationResult,
} from '@/server/terms-consent/application';
import {
  termsConsentCommandDecoder,
  termsConsentIdDecoder,
} from '@/server/terms-consent/public';
import {
  deriveVaultContext,
  type SessionCredentialResolver,
} from '@/server/session-boundary';

const requestBodyLimitBytes = 2_048;

export type TermsConsentHttpDependencies = {
  readonly expectedOrigin: unknown;
  readonly clock: { now(): unknown };
  readonly consentIds: { create(): unknown };
  readonly sessions: SessionCredentialResolver;
  readonly application: TermsConsentApplication;
};

export function createTermsConsentStatusHandler(
  dependencies: Omit<TermsConsentHttpDependencies, 'consentIds'>,
) {
  return async function handleTermsConsentStatus(
    request: Request,
  ): Promise<Response> {
    const now = readClock(dependencies.clock);
    if (now === undefined) return errorResponse(503, 'unavailable');
    const session = await authenticatedSession(request, dependencies, now);
    if (session.kind === 'response') return session.response;
    try {
      return applicationResponse(
        await dependencies.application.status({ context: session.context }),
      );
    } catch {
      return unexpectedFailure();
    }
  };
}

export function createTermsConsentAcceptHandler(
  dependencies: TermsConsentHttpDependencies,
) {
  return async function handleTermsConsentAccept(
    request: Request,
  ): Promise<Response> {
    const now = readClock(dependencies.clock);
    if (now === undefined) return errorResponse(503, 'unavailable');
    const session = await authenticatedSession(request, dependencies, now);
    if (session.kind === 'response') return session.response;

    const body = await readBoundedJson(request);
    if (body.kind === 'too-large') {
      return errorResponse(413, 'request-too-large');
    }
    if (body.kind === 'invalid') {
      return errorResponse(400, 'invalid-request');
    }
    const command = termsConsentCommandDecoder.decode(body.value);
    if (!command.ok) return errorResponse(400, 'invalid-request');

    let consentIdCandidate: unknown;
    try {
      consentIdCandidate = dependencies.consentIds.create();
    } catch {
      return unexpectedFailure();
    }
    const consentId = termsConsentIdDecoder.decode(consentIdCandidate);
    if (!consentId.ok) return errorResponse(503, 'unavailable');

    try {
      return applicationResponse(
        await dependencies.application.accept({
          context: session.context,
          command: command.value,
          consentId: consentId.value,
          acceptedAt: now,
        }),
      );
    } catch {
      return unexpectedFailure();
    }
  };
}

async function authenticatedSession(
  request: Request,
  dependencies: Pick<
    TermsConsentHttpDependencies,
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
  try {
    const result = await deriveVaultContext(
      sessionMetadataFromRequest(request, {
        expectedOrigin: dependencies.expectedOrigin,
        now,
      }),
      dependencies.sessions,
    );
    if (result.kind === 'anonymous') {
      return {
        kind: 'response',
        response: errorResponse(401, 'authentication-required'),
      };
    }
    if (result.kind === 'forbidden') {
      return { kind: 'response', response: errorResponse(403, 'forbidden') };
    }
    return result;
  } catch {
    return { kind: 'response', response: unexpectedFailure() };
  }
}

type BodyReadResult =
  | { readonly kind: 'read'; readonly value: unknown }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'too-large' };

async function readBoundedJson(request: Request): Promise<BodyReadResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return { kind: 'invalid' };
    if (length > requestBodyLimitBytes) return { kind: 'too-large' };
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    return { kind: 'invalid' };
  }
  if (bytes.byteLength > requestBodyLimitBytes) {
    return { kind: 'too-large' };
  }
  try {
    const source = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    const value: unknown = JSON.parse(source);
    return { kind: 'read', value };
  } catch {
    return { kind: 'invalid' };
  }
}

function applicationResponse(result: TermsConsentApplicationResult): Response {
  if (result.kind === 'accepted') {
    return Response.json(
      { outcome: result.outcome, status: result.status },
      { headers: noStoreHeaders },
    );
  }
  switch (result.reason) {
    case 'invalid-command':
      return errorResponse(400, 'invalid-request');
    case 'consent-required':
      return errorResponse(422, 'consent-required');
    case 'stale-terms':
      return errorResponse(409, 'terms-changed');
    case 'identifier-conflict':
      return errorResponse(409, 'request-conflict');
    case 'owner-mismatch':
      return errorResponse(403, 'forbidden');
    case 'invalid-current-terms':
    case 'hash-unavailable':
    case 'classification-required':
    case 'inconsistent-evidence':
    case 'unavailable':
      return errorResponse(503, 'unavailable');
  }
}

function readClock(clock: { now(): unknown }): number | undefined {
  try {
    return nonNegativeSafeInteger(clock.now(), 'terms consent clock');
  } catch {
    return undefined;
  }
}

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders });
}

function unexpectedFailure(): Response {
  console.error('terms consent request failed', 'Error');
  return errorResponse(503, 'unavailable');
}
