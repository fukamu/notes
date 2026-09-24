import { env } from 'cloudflare:workers';
import { resolveServiceRuntimeMode } from '@/server/runtime-mode';
import { enforceLaunchGate } from '@/server/launch-gate/http';

export const runtime = 'edge';

export async function POST(request: Request): Promise<Response> {
  const launchGateResponse = await enforceLaunchGate(request, env);
  if (launchGateResponse) return launchGateResponse;
  const mode = resolveServiceRuntimeMode(env);
  if (mode.kind === 'configured' && mode.mode === 'legacy-test') {
    return unavailable(404);
  }
  // The production composition requires real R2 and KMS-backed ports. Those
  // provider adapters are intentionally not selected by this Issue; never
  // substitute test fakes or an allow-all entitlement path here.
  return unavailable(503);
}

function unavailable(status: 404 | 503): Response {
  return Response.json(
    { error: status === 404 ? 'not-found' : 'unavailable' },
    { status, headers: { 'Cache-Control': 'no-store' } },
  );
}
