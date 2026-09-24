import { env } from 'cloudflare:workers';
import { launchStatusResponse } from '@/server/launch-gate/http';

export const runtime = 'edge';

export async function GET(request: Request): Promise<Response> {
  return launchStatusResponse(request, env);
}
