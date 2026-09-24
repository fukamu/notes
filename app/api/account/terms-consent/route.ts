import { env } from 'cloudflare:workers';
import { resolveServiceRuntimeMode } from '@/server/runtime-mode';
import { enforceLaunchGate } from '@/server/launch-gate/http';

export const runtime = 'edge';

export async function GET(request: Request): Promise<Response> {
  return unavailable(request);
}

export async function POST(request: Request): Promise<Response> {
  return unavailable(request);
}

async function unavailable(request: Request): Promise<Response> {
  const launchGateResponse = await enforceLaunchGate(request, env);
  if (launchGateResponse) return launchGateResponse;
  const mode = resolveServiceRuntimeMode(env);
  const status =
    mode.kind === 'configured' && mode.mode === 'legacy-test' ? 404 : 503;
  return Response.json(
    { error: status === 404 ? 'not-found' : 'unavailable' },
    {
      status,
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
