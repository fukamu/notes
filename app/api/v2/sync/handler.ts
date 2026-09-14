import { BoundaryDecodeError } from '@/lib/codec/core';
import { nonNegativeSafeInteger } from '@/lib/domain/types';
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
  planSyncV2EntitlementLimitAccess,
} from '@/server/sync-v2/http-core';
import type {
  SyncV2Application,
  SyncV2ClockPort,
} from '@/server/sync-v2/public';
import {
  parseQuotaByteCount,
  quotaTransportLimits,
  type QuotaByteCount,
} from '@/server/quota/public';
import { assertNever } from '@/lib/shared/invariant';
import {
  bucketTelemetryCount,
  planTelemetryEvent,
  type TelemetryFailureCategory,
  type TelemetryOutcome,
} from '@/server/telemetry/core';
import {
  noOpTelemetrySink,
  recordTelemetrySafely,
  type TelemetrySink,
} from '@/server/telemetry/public';
import type { SyncV2ApplicationRejection } from '@/server/sync-v2/public';

export type SyncV2HttpDependencies = {
  readonly expectedOrigin: unknown;
  readonly clock: SyncV2ClockPort;
  readonly sessions: SessionCredentialResolver;
  readonly entitlement: Pick<
    EntitlementPort,
    'authorizeCapability' | 'readLimits'
  >;
  readonly application: Pick<SyncV2Application, 'synchronize'>;
  readonly telemetry?: TelemetrySink;
};

type BodyReadResult =
  | {
      readonly kind: 'read';
      readonly value: unknown;
      readonly bytes: QuotaByteCount;
    }
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
      return observedResponse(
        dependencies,
        error instanceof BoundaryDecodeError
          ? errorResponse(503, 'unavailable')
          : unexpectedFailure(error),
        'failure',
        'internal',
        null,
      );
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
      return observedResponse(
        dependencies,
        unexpectedFailure(error),
        'failure',
        'internal',
        null,
      );
    }
    if (session.kind === 'anonymous') {
      return observedResponse(
        dependencies,
        errorResponse(401, 'authentication-required'),
        'denied',
        'authentication',
        null,
      );
    }
    if (session.kind === 'forbidden') {
      return observedResponse(
        dependencies,
        errorResponse(403, 'forbidden'),
        'denied',
        'authorization',
        null,
      );
    }

    const body = await readBoundedJson(request);
    if (body.kind === 'too-large') {
      return observedResponse(
        dependencies,
        errorResponse(413, 'request-too-large'),
        'denied',
        'invalid-input',
        null,
      );
    }
    if (body.kind === 'invalid') {
      return observedResponse(
        dependencies,
        errorResponse(400, 'invalid-request'),
        'denied',
        'invalid-input',
        null,
      );
    }
    let syncRequest;
    try {
      syncRequest = decodeSyncV2Request(body.value);
    } catch (error: unknown) {
      if (error instanceof BoundaryDecodeError) {
        return observedResponse(
          dependencies,
          errorResponse(400, 'invalid-request'),
          'denied',
          'invalid-input',
          null,
        );
      }
      return observedResponse(
        dependencies,
        unexpectedFailure(error),
        'failure',
        'internal',
        null,
      );
    }

    let entitlement;
    try {
      entitlement = await dependencies.entitlement.authorizeCapability(
        session.context,
        'notes-sync',
        now,
      );
    } catch (error: unknown) {
      return observedResponse(
        dependencies,
        unexpectedFailure(error),
        'failure',
        'dependency',
        syncRequest.mutations.length,
      );
    }
    const access = planSyncV2EntitlementAccess(entitlement);
    if (access.kind === 'reject') {
      return observedAccessRejection(
        dependencies,
        access,
        syncRequest.mutations.length,
      );
    }

    let limits;
    try {
      limits = await dependencies.entitlement.readLimits(session.context, now);
    } catch (error: unknown) {
      return observedResponse(
        dependencies,
        unexpectedFailure(error),
        'failure',
        'dependency',
        syncRequest.mutations.length,
      );
    }
    const limitAccess = planSyncV2EntitlementLimitAccess(limits);
    if (limitAccess.kind === 'reject') {
      return observedAccessRejection(
        dependencies,
        limitAccess,
        syncRequest.mutations.length,
      );
    }
    if (limits.kind !== 'available') {
      return observedResponse(
        dependencies,
        errorResponse(503, 'unavailable'),
        'failure',
        'dependency',
        syncRequest.mutations.length,
      );
    }

    try {
      const result = await dependencies.application.synchronize({
        context: session.context,
        request: syncRequest,
        synchronizedAt: now,
        requestBytes: body.bytes,
        limits: limits.limits,
      });
      if (result.kind === 'rejected') {
        const rejected = planSyncV2ApplicationHttpResult(result);
        const telemetry = applicationRejectionTelemetry(result.reason);
        return observedResponse(
          dependencies,
          errorResponse(rejected.status, rejected.error),
          telemetry.outcome,
          telemetry.failureCategory,
          syncRequest.mutations.length,
        );
      }
      const noChange =
        syncRequest.mutations.length === 0 &&
        result.response.changes.length === 0 &&
        result.response.receipts.length === 0;
      return observedResponse(
        dependencies,
        Response.json(encodeSyncV2Response(result.response), {
          headers: noStoreHeaders,
        }),
        noChange ? 'no-change' : 'success',
        'none',
        syncRequest.mutations.length + result.response.changes.length,
      );
    } catch (error: unknown) {
      return observedResponse(
        dependencies,
        unexpectedFailure(error),
        'failure',
        'internal',
        syncRequest.mutations.length,
      );
    }
  };
}

async function readBoundedJson(request: Request): Promise<BodyReadResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return { kind: 'invalid' };
    if (length > quotaTransportLimits.requestBytes) {
      return { kind: 'too-large' };
    }
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    return { kind: 'invalid' };
  }
  if (bytes.byteLength > quotaTransportLimits.requestBytes) {
    return { kind: 'too-large' };
  }
  try {
    const source = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    const value: unknown = JSON.parse(source);
    return {
      kind: 'read',
      value,
      bytes: parseQuotaByteCount(bytes.byteLength),
    };
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
    error instanceof Error ? 'Error' : 'UnknownError',
  );
  return errorResponse(503, 'unavailable');
}

function observedAccessRejection(
  dependencies: SyncV2HttpDependencies,
  access: {
    readonly status: 402 | 403 | 503;
    readonly error: 'online-access-locked' | 'forbidden' | 'unavailable';
  },
  workItems: number,
): Response {
  switch (access.status) {
    case 402:
      return observedResponse(
        dependencies,
        errorResponse(access.status, access.error),
        'locked',
        'billing',
        workItems,
      );
    case 403:
      return observedResponse(
        dependencies,
        errorResponse(access.status, access.error),
        'denied',
        'authorization',
        workItems,
      );
    case 503:
      return observedResponse(
        dependencies,
        errorResponse(access.status, access.error),
        'failure',
        'dependency',
        workItems,
      );
  }
}

function applicationRejectionTelemetry(
  reason: SyncV2ApplicationRejection['reason'],
): Readonly<{
  outcome: TelemetryOutcome;
  failureCategory: TelemetryFailureCategory;
}> {
  switch (reason) {
    case 'invalid-cursor':
    case 'request-limit':
    case 'display-character-limit':
    case 'serialized-plaintext-limit':
    case 'ciphertext-limit':
      return { outcome: 'denied', failureCategory: 'invalid-input' };
    case 'scope-unavailable':
      return { outcome: 'denied', failureCategory: 'authorization' };
    case 'idempotency-key-reuse':
    case 'mutation-conflict':
      return { outcome: 'denied', failureCategory: 'conflict' };
    case 'active-card-limit':
    case 'vault-plaintext-limit':
      return { outcome: 'denied', failureCategory: 'quota' };
    case 'quota-unavailable':
      return { outcome: 'failure', failureCategory: 'dependency' };
    default:
      return assertNever(reason, 'Unhandled Sync V2 rejection telemetry');
  }
}

function observedResponse(
  dependencies: SyncV2HttpDependencies,
  response: Response,
  outcome: TelemetryOutcome,
  failureCategory: TelemetryFailureCategory,
  workItems: number | null,
): Response {
  const bucket = bucketTelemetryCount(workItems);
  if (bucket.kind === 'rejected') return response;
  recordTelemetrySafely(
    dependencies.telemetry ?? noOpTelemetrySink,
    planTelemetryEvent({
      operation: 'sync-v2',
      outcome,
      failureCategory,
      durationBucket: 'not-measured',
      workItemsBucket: bucket.bucket,
    }),
  );
  return response;
}
