import { BoundaryDecodeError } from '@/lib/codec/core';
import { CONTRACT_LIMITS, nonNegativeSafeInteger } from '@/lib/domain/types';
import {
  decodeSyncV2Request,
  encodeSyncV2Response,
} from '@/lib/sync/v2-protocol';
import { sessionMetadataFromRequest } from '@/server/adapters/web-session';
import type { EntitlementPort } from '@/server/entitlement/public';
import {
  deriveVaultContext,
  type SessionCredentialResolver,
} from '@/server/session-boundary';
import {
  planSyncV2ApplicationHttpResult,
  planSyncV2EntitlementAccess,
} from '@/server/sync-v2/http-core';
import type {
  SyncV2Application,
  SyncV2ClockPort,
} from '@/server/sync-v2/public';

export type SyncV2HttpDependencies = {
  readonly expectedOrigin: unknown;
  readonly clock: SyncV2ClockPort;
  readonly sessions: SessionCredentialResolver;
  readonly entitlement: Pick<EntitlementPort, 'authorizeCapability'>;
  readonly application: SyncV2Application;
};

type BodyReadResult =
  | { readonly kind: 'read'; readonly value: unknown }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'too-large' };

export function createSyncV2HttpHandler(dependencies: SyncV2HttpDependencies) {
  return async function handleSyncV2Request(
    request: Request,
  ): Promise<Response> {
    let now: number;
    try {
      now = nonNegativeSafeInteger(dependencies.clock.now(), 'Sync v2 clock');
    } catch (error: unknown) {
      return error instanceof BoundaryDecodeError
        ? errorResponse(503, 'unavailable')
        : unexpectedFailure(error);
    }

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
    let syncRequest;
    try {
      syncRequest = decodeSyncV2Request(body.value);
    } catch (error: unknown) {
      if (error instanceof BoundaryDecodeError) {
        return errorResponse(400, 'invalid-request');
      }
      return unexpectedFailure(error);
    }

    let entitlement;
    try {
      entitlement = await dependencies.entitlement.authorizeCapability(
        session.context,
        'notes-sync',
        now,
      );
    } catch (error: unknown) {
      return unexpectedFailure(error);
    }
    const access = planSyncV2EntitlementAccess(entitlement);
    if (access.kind === 'reject') {
      return errorResponse(access.status, access.error);
    }

    try {
      const result = await dependencies.application.synchronize({
        context: session.context,
        request: syncRequest,
        synchronizedAt: now,
      });
      if (result.kind === 'rejected') {
        const rejected = planSyncV2ApplicationHttpResult(result);
        return errorResponse(rejected.status, rejected.error);
      }
      return Response.json(encodeSyncV2Response(result.response), {
        headers: noStoreHeaders,
      });
    } catch (error: unknown) {
      return unexpectedFailure(error);
    }
  };
}

async function readBoundedJson(request: Request): Promise<BodyReadResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return { kind: 'invalid' };
    if (length > CONTRACT_LIMITS.payloadBytes) return { kind: 'too-large' };
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    return { kind: 'invalid' };
  }
  if (bytes.byteLength > CONTRACT_LIMITS.payloadBytes) {
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

const noStoreHeaders = { 'Cache-Control': 'no-store' } as const;

function errorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: noStoreHeaders });
}

function unexpectedFailure(error: unknown): Response {
  console.error(
    'sync v2 failed',
    error instanceof Error ? error.name : 'UnknownError',
  );
  return errorResponse(503, 'unavailable');
}
