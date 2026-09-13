import { getD1Binding } from '@/db/environment';
import { synchronize } from '@/db/d1-sync';
import { BoundaryDecodeError } from '@/lib/codec/core';
import { CONTRACT_LIMITS } from '@/lib/domain/types';
import { decodeSyncRequest, decodeSyncResponse } from '@/lib/sync/protocol';
import { legacySyncIsEnabled } from '@/server/runtime-mode';

class PayloadTooLargeError extends Error {}

async function readJson(request: Request): Promise<unknown> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > CONTRACT_LIMITS.payloadBytes) {
      throw new PayloadTooLargeError();
    }
  }

  const bytes = await request.clone().arrayBuffer();
  if (bytes.byteLength > CONTRACT_LIMITS.payloadBytes) {
    throw new PayloadTooLargeError();
  }
  const input: unknown = await request.json();
  return input;
}

function inputError(status = 400): Response {
  return Response.json({ error: '同期データが正しくありません。' }, { status });
}

export async function handleSyncRequest(
  request: Request,
  environment: unknown,
): Promise<Response> {
  if (!legacySyncIsEnabled(environment)) {
    return Response.json(
      { error: 'この同期経路は利用できません。' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  let input: ReturnType<typeof decodeSyncRequest>;
  try {
    input = decodeSyncRequest(await readJson(request));
  } catch (error) {
    if (error instanceof PayloadTooLargeError) return inputError(413);
    if (error instanceof SyntaxError || error instanceof BoundaryDecodeError) {
      return inputError();
    }
    throw error;
  }

  try {
    const database = getD1Binding(environment);
    const candidate: unknown = await synchronize(database, input.mutations);
    const response = decodeSyncResponse(candidate, input.mutations);
    return Response.json(response, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    // Keep operational diagnostics server-side without serializing request data
    // or database values into logs or responses.
    console.error(
      'sync failed',
      error instanceof Error ? error.name : 'UnknownError',
    );
    return Response.json(
      { error: '同期に失敗しました。入力内容は端末に残っています。' },
      { status: 500 },
    );
  }
}
