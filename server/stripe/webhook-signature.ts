import { STRIPE_MAX_WEBHOOK_BYTES, STRIPE_WEBHOOK_TOLERANCE_MS } from './core';
import type { StripeWebhookVerifierPort } from './ports';
import type { StripeWebhookSecret } from './public';

type StripeSignatureHeader = {
  readonly timestampSeconds: number;
  readonly v1Signatures: readonly Uint8Array[];
};

export function createWebCryptoStripeWebhookVerifier(
  secret: StripeWebhookSecret,
  toleranceMs = STRIPE_WEBHOOK_TOLERANCE_MS,
): StripeWebhookVerifierPort {
  if (!Number.isSafeInteger(toleranceMs) || toleranceMs <= 0) {
    throw new Error('Stripe webhook tolerance must be a positive integer');
  }
  return {
    async verify(input) {
      if (
        !(input.rawBody instanceof Uint8Array) ||
        input.rawBody.byteLength === 0 ||
        input.rawBody.byteLength > STRIPE_MAX_WEBHOOK_BYTES ||
        !Number.isSafeInteger(input.receivedAt) ||
        input.receivedAt < 0
      ) {
        return { kind: 'rejected' };
      }
      const header = parseStripeSignatureHeader(input.signatureHeader);
      if (header === undefined) return { kind: 'rejected' };
      const timestampMs = header.timestampSeconds * 1_000;
      if (
        !Number.isSafeInteger(timestampMs) ||
        Math.abs(input.receivedAt - timestampMs) > toleranceMs
      ) {
        return { kind: 'rejected' };
      }

      const rawBody = Uint8Array.from(input.rawBody);
      try {
        const key = await crypto.subtle.importKey(
          'raw',
          toArrayBuffer(new TextEncoder().encode(secret)),
          { name: 'HMAC', hash: 'SHA-256' },
          false,
          ['verify'],
        );
        const signedPayload = concatBytes(
          new TextEncoder().encode(`${header.timestampSeconds}.`),
          rawBody,
        );
        for (const signature of header.v1Signatures) {
          if (
            await crypto.subtle.verify(
              'HMAC',
              key,
              toArrayBuffer(signature),
              toArrayBuffer(signedPayload),
            )
          ) {
            return { kind: 'verified', rawBody };
          }
        }
      } catch {
        return { kind: 'rejected' };
      }
      return { kind: 'rejected' };
    },
  };
}

export function parseStripeSignatureHeader(
  input: unknown,
): StripeSignatureHeader | undefined {
  if (typeof input !== 'string' || input.length === 0 || input.length > 8_192) {
    return undefined;
  }
  let timestamp: number | undefined;
  const signatures: Uint8Array[] = [];
  for (const component of input.split(',')) {
    const separator = component.indexOf('=');
    if (separator <= 0 || separator === component.length - 1) return undefined;
    const name = component.slice(0, separator);
    const value = component.slice(separator + 1);
    if (name === 't') {
      if (timestamp !== undefined || !/^\d{1,16}$/.test(value)) {
        return undefined;
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed < 0) return undefined;
      timestamp = parsed;
    } else if (name === 'v1') {
      const signature = decodeHexSha256(value);
      if (signature === undefined) return undefined;
      signatures.push(signature);
    }
  }
  return timestamp === undefined || signatures.length === 0
    ? undefined
    : { timestampSeconds: timestamp, v1Signatures: signatures };
}

function decodeHexSha256(value: string): Uint8Array | undefined {
  if (!/^[a-f0-9]{64}$/.test(value)) return undefined;
  const output = new Uint8Array(32);
  for (let index = 0; index < output.length; index += 1) {
    const byte = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
    if (!Number.isSafeInteger(byte)) return undefined;
    output[index] = byte;
  }
  return output;
}

function concatBytes(prefix: Uint8Array, body: Uint8Array): Uint8Array {
  const output = new Uint8Array(prefix.byteLength + body.byteLength);
  output.set(prefix, 0);
  output.set(body, prefix.byteLength);
  return output;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = Uint8Array.from(bytes);
  return copy.buffer;
}
