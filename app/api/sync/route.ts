import { env } from 'cloudflare:workers';
import { handleSyncRequest } from './handler';

export const runtime = 'edge';

export async function POST(request: Request): Promise<Response> {
  return handleSyncRequest(request, env);
}
