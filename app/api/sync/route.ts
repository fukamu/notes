import { env } from 'cloudflare:workers';
import { synchronize } from '@/db/d1-sync';
import { isUuidV7 } from '@/lib/domain/id';
import type { BodySegment, PendingMutation } from '@/lib/domain/types';

export const runtime = 'edge';

function isBody(value: unknown): value is BodySegment[] {
  return (
    Array.isArray(value) &&
    value.every((segment) => {
      if (!segment || typeof segment !== 'object' || !('type' in segment)) return false;
      if (segment.type === 'text') {
        return 'text' in segment && typeof segment.text === 'string';
      }
      return (
        segment.type === 'link' &&
        'targetCardId' in segment &&
        typeof segment.targetCardId === 'string' &&
        isUuidV7(segment.targetCardId)
      );
    })
  );
}

function isMutation(value: unknown): value is PendingMutation {
  if (!value || typeof value !== 'object') return false;
  const mutation = value as Partial<PendingMutation>;
  return (
    typeof mutation.mutationId === 'string' &&
    isUuidV7(mutation.mutationId) &&
    typeof mutation.cardId === 'string' &&
    isUuidV7(mutation.cardId) &&
    (mutation.kind === 'upsert' || mutation.kind === 'resolve') &&
    (mutation.baseServerRevision === null ||
      (Number.isInteger(mutation.baseServerRevision) && mutation.baseServerRevision! > 0)) &&
    typeof mutation.title === 'string' &&
    isBody(mutation.body) &&
    typeof mutation.createdAt === 'number' &&
    typeof mutation.updatedAt === 'number' &&
    Array.isArray(mutation.conflictIds) &&
    mutation.conflictIds.every((id) => typeof id === 'string')
  );
}

export async function POST(request: Request): Promise<Response> {
  try {
    const input = (await request.json()) as { deviceId?: unknown; mutations?: unknown };
    if (
      typeof input.deviceId !== 'string' ||
      !isUuidV7(input.deviceId) ||
      !Array.isArray(input.mutations) ||
      input.mutations.length > 500 ||
      !input.mutations.every(isMutation)
    ) {
      return Response.json({ error: '同期データが正しくありません。' }, { status: 400 });
    }

    const response = await synchronize(env.DB, input.mutations);
    return Response.json(response, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    console.error('sync failed', error);
    return Response.json(
      { error: '同期に失敗しました。入力内容は端末に残っています。' },
      { status: 500 },
    );
  }
}
