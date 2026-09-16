import { nonNegativeSafeInteger } from '@/lib/domain/types';

export const billingRequestBodyLimitBytes = 2_048;

export const billingNoStoreHeaders = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
} as const;

export type BillingBodyReadResult =
  | { readonly kind: 'read'; readonly value: unknown }
  | { readonly kind: 'invalid' }
  | { readonly kind: 'too-large' };

export function readBillingClock(clock: {
  now(): unknown;
}): number | undefined {
  try {
    return nonNegativeSafeInteger(clock.now(), 'billing HTTP clock');
  } catch {
    return undefined;
  }
}

export async function readBillingJson(
  request: Request,
): Promise<BillingBodyReadResult> {
  const declaredLength = request.headers.get('content-length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length < 0) return { kind: 'invalid' };
    if (length > billingRequestBodyLimitBytes) {
      return { kind: 'too-large' };
    }
  }
  let bytes: ArrayBuffer;
  try {
    bytes = await request.arrayBuffer();
  } catch {
    return { kind: 'invalid' };
  }
  if (bytes.byteLength > billingRequestBodyLimitBytes) {
    return { kind: 'too-large' };
  }
  try {
    const source = new TextDecoder('utf-8', {
      fatal: true,
      ignoreBOM: false,
    }).decode(bytes);
    const value: unknown = JSON.parse(source);
    return { kind: 'read', value };
  } catch {
    return { kind: 'invalid' };
  }
}

export function billingErrorResponse(status: number, error: string): Response {
  return Response.json({ error }, { status, headers: billingNoStoreHeaders });
}

export function unexpectedBillingFailure(
  operation: 'checkout' | 'cancellation',
): Response {
  console.error(`billing ${operation} request failed`, 'Error');
  return billingErrorResponse(503, 'unavailable');
}
