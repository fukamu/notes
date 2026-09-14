import { env } from 'cloudflare:workers';
import { resolveServiceRuntimeMode } from '@/server/runtime-mode';

export const runtime = 'edge';

export async function POST(): Promise<Response> {
  const mode = resolveServiceRuntimeMode(env);
  if (mode.kind === 'configured' && mode.mode === 'legacy-test') {
    return unavailable(404);
  }
  // See the start route: provider-neutral handlers are implemented, while
  // production wiring remains unavailable until every real binding is chosen.
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
