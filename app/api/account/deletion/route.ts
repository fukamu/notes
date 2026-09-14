import { env } from 'cloudflare:workers';
import { resolveServiceRuntimeMode } from '@/server/runtime-mode';

export const runtime = 'edge';

export async function POST(): Promise<Response> {
  const mode = resolveServiceRuntimeMode(env);
  if (mode.kind === 'configured' && mode.mode === 'legacy-test') {
    return unavailable(404);
  }
  // Production composition needs explicit D1, provider cancellation, private
  // object storage, encryption, and keyed continuation credential bindings.
  // Never substitute test fakes at this public route.
  return unavailable(503);
}

function unavailable(status: 404 | 503): Response {
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
