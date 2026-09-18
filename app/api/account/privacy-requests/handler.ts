import { nonNegativeSafeInteger } from '@/lib/domain/types';
import { sessionMetadataFromRequest } from '@/server/adapters/web-session';
import {
  privacyRequestStatusCommandDecoder,
  privacyRequestSubmitCommandDecoder,
  type PrivacyRequestPublicStatus,
} from '@/server/privacy-request/application-core';
import type {
  PrivacyRequestApplication,
  PrivacyRequestApplicationResult,
} from '@/server/privacy-request/application';
import {
  privacyRequestIdDecoder,
  privacyRequestScope,
} from '@/server/privacy-request/public';
import {
  deriveVaultContext,
  type SessionCredentialResolver,
} from '@/server/session-boundary';

const requestBodyLimitBytes = 2_048;

export type PrivacyRequestHttpDependencies = {
  readonly expectedOrigin: unknown;
  readonly clock: { now(): unknown };
  readonly requestIds: { create(): unknown };
  readonly sessions: SessionCredentialResolver;
  readonly application: PrivacyRequestApplication;
};

export function createPrivacyRequestSubmitHandler(
  dependencies: PrivacyRequestHttpDependencies,
) {
  return async function handlePrivacyRequestSubmit(
    request: Request,
  ): Promise<Response> {
    const now = readClock(dependencies.clock);
    if (now === undefined) return errorResponse(503, 'unavailable');
    const session = await authenticatedSession(request, dependencies, now);
    if (session.kind !== 'authenticated') return session.response;

    const body = await readBoundedJson(request);
    if (body.kind === 'too-large') {
      return errorResponse(413, 'request-too-large');
    }
    if (body.kind === 'invalid') {
      return errorResponse(400, 'invalid-request');
    }
    const decoded = privacyRequestSubmitCommandDecoder.decode(body.value);
    if (!decoded.ok) return errorResponse(400, 'invalid-request');
    const requestId = createRequestId(dependencies.requestIds);
    if (requestId === undefined) return errorResponse(503, 'unavailable');

    try {
      return applicationResponse(
        await dependencies.application.submit({
          scope: privacyRequestScope(session.context),
          command: decoded.value,
          requestId,
          requestedAt: now,
        }),
      );
    } catch (error: unknown) {
      return unexpectedFailure(error);
    }
  };
}

export function createPrivacyRequestStatusHandler(
  dependencies: Omit<PrivacyRequestHttpDependencies, 'requestIds'>,
) {
  return async function handlePrivacyRequestStatus(
    request: Request,
  ): Promise<Response> {
    const now = readClock(dependencies.clock);
    if (now === undefined) return errorResponse(503, 'unavailable');
    const session = await authenticatedSession(request, dependencies, now);
    if (session.kind !== 'authenticated') return session.response;

    const body = await readBoundedJson(request);
    if (body.kind === 'too-large') {
      return errorResponse(413, 'request-too-large');
    }
    if (body.kind === 'invalid') {
      return errorResponse(400, 'invalid-request');
    }
    const decoded = privacyRequestStatusCommandDecoder.decode(body.value);
    if (!decoded.ok) return errorResponse(400, 'invalid-request');

    try {
      return applicationResponse(
        await dependencies.application.status({
          scope: privacyRequestScope(session.context),
          requestId: decoded.value.requestId,
        }),
      );
    } catch (error: unknown) {
      return unexpectedFailure(error);
    }
  };
}

async function authenticatedSession(
  request: Request,
  dependencies: Pick<
    PrivacyRequestHttpDependencies,
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
  | { readonly kind: 'rejected'; readonly response: Response }
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
        kind: 'rejected',
        response: errorResponse(401, 'authentication-required'),
      };
    }
    if (result.kind === 'forbidden') {
      return {
        kind: 'rejected',
        response: errorResponse(403, 'forbidden'),
      };
    }
    return { kind: 'authenticated', context: result.context };
  } catch (error: unknown) {
    return { kind: 'rejected', response: unexpectedFailure(error) };
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

function applicationResponse(
  result: PrivacyRequestApplicationResult,
): Response {
  if (result.kind === 'rejected') {
    switch (result.reason) {
      case 'identifier-conflict':
      case 'invalid-state':
        return errorResponse(409, 'request-conflict');
      case 'invalid-input':
        return errorResponse(400, 'invalid-request');
      case 'not-found':
        return errorResponse(404, 'not-found');
      case 'unavailable':
        return errorResponse(503, 'unavailable');
    }
  }
  return Response.json(result.request, {
    status: terminalStatus(result.request.status) ? 200 : 202,
    headers: noStoreHeaders,
  });
}

function terminalStatus(status: PrivacyRequestPublicStatus['status']): boolean {
  return status === 'completed' || status === 'rejected' || status === 'failed';
}

function createRequestId(generator: { create(): unknown }) {
  try {
    const decoded = privacyRequestIdDecoder.decode(generator.create());
    return decoded.ok ? decoded.value : undefined;
  } catch {
    return undefined;
  }
}

function readClock(clock: { now(): unknown }): number | undefined {
  try {
    return nonNegativeSafeInteger(clock.now(), 'privacy request clock');
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

function unexpectedFailure(_error: unknown): Response {
  console.error('privacy request failed', 'Error');
  return errorResponse(503, 'unavailable');
}
