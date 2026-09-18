import { env } from 'cloudflare:workers';
import { resolveServiceRuntimeMode } from '@/server/runtime-mode';

export const runtime = 'edge';

export async function POST(): Promise<Response> {
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
