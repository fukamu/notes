import { getD1Binding } from '../../db/environment';
import {
  decideLaunchAccess,
  launchGateIsEnforced,
  parseLaunchUserId,
  type LaunchGateDecision,
} from './core';
import { readLaunchGateDecision } from './d1';
import { buildRuntimeMode } from './runtime';

export const sitesAuthenticatedUserIdHeader =
  'oai-authenticated-user-id' as const;

export const launchGatePrivateHeaders = {
  'Cache-Control': 'private, no-store',
  Vary: `Cookie, ${sitesAuthenticatedUserIdHeader}`,
  'X-Content-Type-Options': 'nosniff',
} as const;

export type LaunchGateResolution =
  | {
      readonly kind: 'ready';
      readonly authenticated: boolean;
      readonly decision: LaunchGateDecision;
    }
  | { readonly kind: 'unavailable' };

export async function resolveLaunchGate(
  request: Request,
  environment: unknown,
  nodeEnvironment: unknown = buildRuntimeMode(),
): Promise<LaunchGateResolution> {
  const rawUserId = request.headers.get(sitesAuthenticatedUserIdHeader);
  const userId = parseLaunchUserId(rawUserId);

  if (!launchGateIsEnforced(nodeEnvironment)) {
    return {
      kind: 'ready',
      authenticated: userId !== undefined,
      decision: decideLaunchAccess({
        publicAccessEnabled: true,
        userAllowed: false,
      }),
    };
  }

  if (rawUserId !== null && userId === undefined) {
    return { kind: 'unavailable' };
  }

  try {
    const decision = await readLaunchGateDecision(
      getD1Binding(environment),
      userId,
    );
    return {
      kind: 'ready',
      authenticated: userId !== undefined,
      decision,
    };
  } catch {
    return { kind: 'unavailable' };
  }
}

export async function enforceLaunchGate(
  request: Request,
  environment: unknown,
  nodeEnvironment: unknown = buildRuntimeMode(),
): Promise<Response | undefined> {
  const resolution = await resolveLaunchGate(
    request,
    environment,
    nodeEnvironment,
  );
  if (resolution.kind === 'unavailable') {
    return Response.json(
      { error: 'launch-gate-unavailable' },
      { status: 503, headers: launchGatePrivateHeaders },
    );
  }
  if (!resolution.decision.canAccess) {
    return Response.json(
      { error: 'launch-access-denied' },
      { status: 403, headers: launchGatePrivateHeaders },
    );
  }
  return undefined;
}

export async function launchStatusResponse(
  request: Request,
  environment: unknown,
  nodeEnvironment: unknown = buildRuntimeMode(),
): Promise<Response> {
  const resolution = await resolveLaunchGate(
    request,
    environment,
    nodeEnvironment,
  );
  if (resolution.kind === 'unavailable') {
    return Response.json(
      { error: 'launch-gate-unavailable' },
      { status: 503, headers: launchGatePrivateHeaders },
    );
  }
  return Response.json(
    {
      publicAccessEnabled: resolution.decision.publicAccessEnabled,
      userAllowed: resolution.decision.userAllowed,
      canAccess: resolution.decision.canAccess,
      authenticated: resolution.authenticated,
    },
    { headers: launchGatePrivateHeaders },
  );
}
