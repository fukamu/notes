import { nonNegativeSafeInteger } from '@/lib/domain/types';
import {
  sessionMetadataFromRequest,
  serializeSessionCookie,
} from '@/server/adapters/web-session';
import {
  accountDeletionScope,
  accountDeletionResumeRequestDecoder,
  accountDeletionStartRequestDecoder,
  type AccountDeletionApplication,
  type AccountDeletionApplicationResult,
} from '@/server/account-deletion/public';
import { evaluateCsrfRequest } from '@/server/core/csrf';
import { clearSessionCookie } from '@/server/core/session-cookie';
import {
  deriveVaultContext,
  type SessionCredentialResolver,
} from '@/server/session-boundary';

const requestBodyLimitBytes = 2_048;

export type AccountDeletionHttpDependencies = {
  readonly expectedOrigin: unknown;
  readonly clock: { now(): unknown };
  readonly sessions: SessionCredentialResolver;
  readonly application: AccountDeletionApplication;
};

export function createAccountDeletionStartHandler(
  dependencies: AccountDeletionHttpDependencies,
) {
  return async function handleAccountDeletionStart(
    request: Request,
  ): Promise<Response> {
    const now = readClock(dependencies.clock);
    if (now === undefined) return errorResponse(503, 'unavailable');

    let session;
    try {
      session = await deriveVaultContext(
        sessionMetadataFromRequest(request, {
          expectedOrigin: dependencies.expectedOrigin,
          now,
        }),
        dependencies.sessions,
      );
    } catch (error: unknown) {
      return unexpectedFailure(error);
    }
    if (session.kind === 'anonymous') {
      return errorResponse(401, 'authentication-required');
    }
    if (session.kind === 'forbidden') {
      return errorResponse(403, 'forbidden');
    }

    const body = await readBoundedJson(request);
    if (body.kind === 'too-large') {
      return errorResponse(413, 'request-too-large');
    }
    if (body.kind === 'invalid') {
      return errorResponse(400, 'invalid-request');
    }
    const decoded = accountDeletionStartRequestDecoder.decode(body.value);
    if (!decoded.ok) return errorResponse(400, 'invalid-request');

    let result: AccountDeletionApplicationResult;
    try {
      result = await dependencies.application.start({
        scope: accountDeletionScope(session.context),
        idempotencyKey: decoded.value.idempotencyKey,
        requestedAt: now,
      });
    } catch (error: unknown) {
      return unexpectedFailure(error);
    }
    return applicationResponse(result, false);
  };
}

export function createAccountDeletionResumeHandler(
  dependencies: Pick<
    AccountDeletionHttpDependencies,
    'application' | 'clock' | 'expectedOrigin'
  >,
) {
  return async function handleAccountDeletionResume(
    request: Request,
  ): Promise<Response> {
    const now = readClock(dependencies.clock);
    if (now === undefined) return errorResponse(503, 'unavailable');
    const metadata = sessionMetadataFromRequest(request, {
      expectedOrigin: dependencies.expectedOrigin,
      now,
    });
    const csrf = evaluateCsrfRequest({
      method: metadata.method,
      expectedOrigin: metadata.expectedOrigin,
      originHeader: metadata.originHeader,
      secFetchSiteHeader: metadata.secFetchSiteHeader,
    });
    if (csrf.kind === 'denied') return errorResponse(403, 'forbidden');

    const body = await readBoundedJson(request);
    if (body.kind === 'too-large') {
      return errorResponse(413, 'request-too-large');
    }
    if (body.kind === 'invalid') {
      return errorResponse(400, 'invalid-request');
    }
    const decoded = accountDeletionResumeRequestDecoder.decode(body.value);
    if (!decoded.ok) return errorResponse(401, 'continuation-required');

    let result: AccountDeletionApplicationResult;
    try {
      result = await dependencies.application.resume({
        token: decoded.value.continuationToken,
        resumedAt: now,
      });
    } catch (error: unknown) {
      return unexpectedFailure(error);
    }
    return applicationResponse(result, result.kind === 'accepted');
  };
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

function applicationResponse(
  result: AccountDeletionApplicationResult,
  clearSession: boolean,
): Response {
  if (result.kind === 'rejected') {
    switch (result.reason) {
      case 'credential-conflict':
        return errorResponse(409, 'request-conflict');
      case 'invalid-capability':
        return errorResponse(401, 'continuation-required');
      case 'invalid-input':
        return errorResponse(400, 'invalid-request');
      case 'unavailable':
        return errorResponse(503, 'unavailable');
    }
  }
  const body = publicStatusBody(result);
  const headers = new Headers(noStoreHeaders);
  if (clearSession) {
    headers.set('Set-Cookie', serializeSessionCookie(clearSessionCookie()));
  }
  return Response.json(body, {
    status:
      result.status.kind === 'completed' || result.status.kind === 'failed'
        ? 200
        : 202,
    headers,
  });
}

function publicStatusBody(
  result: Extract<AccountDeletionApplicationResult, { kind: 'accepted' }>,
): Record<string, unknown> {
  switch (result.status.kind) {
    case 'in-progress':
      return {
        status: result.status.kind,
        continuationToken: requiredContinuationToken(result),
      };
    case 'retry-wait':
      return {
        status: result.status.kind,
        retryAt: result.status.retryAt,
        continuationToken: requiredContinuationToken(result),
      };
    case 'failed':
    case 'completed':
      return { status: result.status.kind };
  }
}

function requiredContinuationToken(
  result: Extract<AccountDeletionApplicationResult, { kind: 'accepted' }>,
) {
  if ('continuationToken' in result) return result.continuationToken;
  throw new Error('non-terminal account deletion status requires a token');
}

function readClock(clock: { now(): unknown }): number | undefined {
  try {
    return nonNegativeSafeInteger(clock.now(), 'account deletion clock');
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

function unexpectedFailure(error: unknown): Response {
  console.error(
    'account deletion request failed',
    error instanceof Error ? error.name : 'UnknownError',
  );
  return errorResponse(503, 'unavailable');
}
